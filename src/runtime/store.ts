import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IssuePacket } from "../intake/types.ts";
import { issuePacketId } from "../intake/types.ts";
import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";
import { isLifecycleState, newIssueSnapshot } from "./state-machine.ts";

export class SqliteControlPlaneStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.initialize();
  }

  static open(path: string): SqliteControlPlaneStore {
    mkdirSync(dirname(path), { recursive: true });
    return new SqliteControlPlaneStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  listRuntimeTables(): string[] {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name as string);
  }

  createIssue(snapshot: IssueSnapshot): IssueSnapshot & { id: string } {
    this.insertSnapshot(snapshot);
    return { ...snapshot, id: snapshot.issue_id };
  }

  getIssue(issueId: string): IssueSnapshot {
    const row = this.db.prepare("SELECT snapshot_json FROM issues WHERE id = ?").get(issueId);
    if (!row) {
      throw new Error(`Issue ${issueId} not found`);
    }
    return JSON.parse(row.snapshot_json as string) as IssueSnapshot;
  }

  listHistory(issueId: string): HistoryEntry[] {
    return this.db.prepare(`
      SELECT id, sequence, event_type, payload_json, created_at
      FROM issue_history
      WHERE issue_id = ?
      ORDER BY sequence
    `).all(issueId).map((row) => ({
      id: row.id as number,
      sequence: row.sequence as number,
      event_type: row.event_type as string,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      created_at: row.created_at as string,
    }));
  }

  listIssues(): IssueSnapshot[] {
    return this.db.prepare(`
      SELECT snapshot_json
      FROM issues
      ORDER BY
        CASE
          WHEN id LIKE 'github:%' AND SUBSTR(id, 8) GLOB '[0-9]*' AND SUBSTR(id, 8) NOT GLOB '*[^0-9]*' THEN 0
          ELSE 1
        END,
        CASE
          WHEN id LIKE 'github:%' AND SUBSTR(id, 8) GLOB '[0-9]*' AND SUBSTR(id, 8) NOT GLOB '*[^0-9]*'
            THEN CAST(SUBSTR(id, 8) AS INTEGER)
          ELSE NULL
        END,
        id
    `).all().map((row) => JSON.parse(row.snapshot_json as string) as IssueSnapshot);
  }

  listHistoriesByIssueId(issueIds: string[]): Map<string, HistoryEntry[]> {
    const histories = new Map<string, HistoryEntry[]>();
    if (issueIds.length === 0) {
      return histories;
    }

    const uniqueIssueIds = [...new Set(issueIds)];
    for (const issueId of uniqueIssueIds) {
      histories.set(issueId, []);
    }

    const placeholders = uniqueIssueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT issue_id, id, sequence, event_type, payload_json, created_at
      FROM issue_history
      WHERE issue_id IN (${placeholders})
      ORDER BY issue_id, sequence
    `).all(...uniqueIssueIds) as {
      issue_id: string;
      id: number;
      sequence: number;
      event_type: string;
      payload_json: string;
      created_at: string;
    }[];

    for (const row of rows) {
      const history: HistoryEntry = {
        id: row.id,
        sequence: row.sequence,
        event_type: row.event_type,
        payload: JSON.parse(row.payload_json),
        created_at: row.created_at,
      };
      const list = histories.get(row.issue_id);
      if (list) {
        list.push(history);
      }
    }

    return histories;
  }

  listActiveIssues(): IssueSnapshot[] {
    return this.db.prepare(`
      SELECT snapshot_json
      FROM issues
      WHERE lifecycle_state IN ('claimed', 'running', 'verifying', 'releasing')
      ORDER BY CASE lifecycle_state
        WHEN 'claimed' THEN 1
        WHEN 'running' THEN 2
        WHEN 'verifying' THEN 3
        WHEN 'releasing' THEN 4
      END, id
    `).all().map((row) => JSON.parse(row.snapshot_json as string) as IssueSnapshot);
  }

  listRecentHistory(issueId: string, limit = 20): HistoryEntry[] {
    return this.db.prepare(`
      SELECT id, sequence, event_type, payload_json, created_at
      FROM (
        SELECT id, sequence, event_type, payload_json, created_at
        FROM issue_history
        WHERE issue_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence
    `).all(issueId, limit).map((row) => ({
      id: row.id as number,
      sequence: row.sequence as number,
      event_type: row.event_type as string,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      created_at: row.created_at as string,
    }));
  }

  appendHistoryAndUpdateSnapshot(
    issueId: string,
    history: HistoryEntry,
    nextSnapshot: IssueSnapshot,
  ): { historyId: number; historySequence: number } {
    this.db.exec("BEGIN");
    try {
      const sequence = this.nextSequence(issueId);
      const historyId = this.insertHistory(issueId, sequence, history);
      validateSnapshot(nextSnapshot);
      this.updateSnapshot(issueId, nextSnapshot);
      this.db.exec("COMMIT");
      return { historyId, historySequence: sequence };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendHistoryBatchAndUpdateSnapshot(
    issueId: string,
    historyEntries: HistoryEntry[],
    nextSnapshot: IssueSnapshot,
  ): { historyCount: number } {
    this.db.exec("BEGIN");
    try {
      let sequence = this.nextSequence(issueId);
      for (const history of historyEntries) {
        this.insertHistory(issueId, sequence, history);
        sequence += 1;
      }
      validateSnapshot(nextSnapshot);
      this.updateSnapshot(issueId, nextSnapshot);
      this.db.exec("COMMIT");
      return { historyCount: historyEntries.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordIdempotentHistory(issueId: string, history: HistoryEntry): { historyId: number; historySequence: number } {
    const idempotencyKey = history.payload.idempotency_key;
    if (typeof idempotencyKey === "string") {
      const existing = this.listHistory(issueId).find((entry) => entry.payload.idempotency_key === idempotencyKey);
      if (existing?.id && existing.sequence) {
        return { historyId: existing.id, historySequence: existing.sequence };
      }
    }

    this.db.exec("BEGIN");
    try {
      const sequence = this.nextSequence(issueId);
      const historyId = this.insertHistory(issueId, sequence, history);
      this.db.exec("COMMIT");
      return { historyId, historySequence: sequence };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertIssuePacket(packet: IssuePacket): void {
    const issueId = issuePacketId(packet);
    const existingRow = this.db.prepare("SELECT snapshot_json FROM issues WHERE id = ?").get(issueId);
    const snapshot = existingRow
      ? JSON.parse(String((existingRow as { snapshot_json: string }).snapshot_json)) as IssueSnapshot
      : newIssueSnapshot(issueId, { lifecycle_state: packet.ready_for_agent ? "ready" : "quarantined" });
    const existingPacket = snapshot.runtime_context_json.issue_packet;
    const packetChanged = JSON.stringify(existingPacket ?? null) !== JSON.stringify(packet);

    snapshot.runtime_context_json = {
      ...snapshot.runtime_context_json,
      issue_packet: packet,
    };

    this.db.exec("BEGIN");
    try {
      if (!existingRow || packetChanged) {
        const sequence = this.nextSequence(issueId);
        this.insertHistory(issueId, sequence, {
          event_type: existingRow ? "intake_packet_updated" : "intake_packet",
          payload: packet,
        });
      }
      if (existingRow) {
        this.updateSnapshot(issueId, snapshot);
      } else {
        this.insertSnapshot(snapshot);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAllIssuesForTests(): IssueSnapshot[] {
    return this.db.prepare("SELECT snapshot_json FROM issues ORDER BY id").all()
      .map((row) => JSON.parse(String((row as { snapshot_json: string }).snapshot_json)) as IssueSnapshot);
  }

  listHistoryForTests(issueId: string): HistoryEntry[] {
    return this.listHistory(issueId);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        lifecycle_state TEXT NOT NULL,
        current_session_id TEXT,
        worktree_path TEXT,
        runtime_context_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_history (
        id INTEGER PRIMARY KEY,
        issue_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issue_history_issue_id_sequence
      ON issue_history(issue_id, sequence);

    `);
  }

  private nextSequence(issueId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM issue_history WHERE issue_id = ?").get(issueId);
    return row?.sequence as number;
  }

  private insertHistory(issueId: string, sequence: number, history: HistoryEntry): number {
    const result = this.db.prepare(`
      INSERT INTO issue_history (issue_id, sequence, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      issueId,
      sequence,
      history.event_type,
      JSON.stringify(history.payload),
      history.created_at ?? new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  private insertSnapshot(snapshot: IssueSnapshot): void {
    validateSnapshot(snapshot);
    this.db.prepare(`
      INSERT INTO issues (
        id,
        lifecycle_state,
        current_session_id,
        worktree_path,
        runtime_context_json,
        snapshot_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.issue_id,
      snapshot.lifecycle_state,
      snapshot.current_session_id ?? null,
      snapshot.worktree_path ?? null,
      JSON.stringify(snapshot.runtime_context_json),
      JSON.stringify(snapshot),
      new Date().toISOString(),
    );
  }

  private updateSnapshot(issueId: string, snapshot: IssueSnapshot): void {
    const result = this.db.prepare(`
      UPDATE issues
      SET lifecycle_state = ?,
          current_session_id = ?,
          worktree_path = ?,
          runtime_context_json = ?,
          snapshot_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      snapshot.lifecycle_state,
      snapshot.current_session_id ?? null,
      snapshot.worktree_path ?? null,
      JSON.stringify(snapshot.runtime_context_json),
      JSON.stringify(snapshot),
      new Date().toISOString(),
      issueId,
    );

    if (result.changes !== 1) {
      throw new Error(`Issue ${issueId} not found`);
    }
  }
}

function validateSnapshot(snapshot: IssueSnapshot): void {
  if (!isLifecycleState(snapshot.lifecycle_state)) {
    throw new Error(`Invalid lifecycle_state: ${snapshot.lifecycle_state}`);
  }
}
