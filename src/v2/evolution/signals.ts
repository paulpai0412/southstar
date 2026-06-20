import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { createLearningNode } from "./learning-graph.ts";

export type LearningSignalInput = Record<string, unknown> & {
  signalKind: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  scope?: string;
  sourceRefs?: string[];
};

export async function recordLearningSignal(db: SouthstarDb, input: LearningSignalInput): Promise<{ nodeId: string }> {
  rejectUnsafeSignalPayload(input);
  const sanitized = redactSecrets(input) as LearningSignalInput;
  const node = await createLearningNode(db, {
    nodeType: "learning_signal",
    scope: typeof sanitized.scope === "string" ? sanitized.scope : "software",
    status: "recorded",
    runId: sanitized.runId,
    taskId: sanitized.taskId,
    sessionId: sanitized.sessionId,
    payload: sanitized,
    summaryText: signalSummary(sanitized),
  });

  if (sanitized.runId && await runExists(db, sanitized.runId)) {
    await appendSignalHistory(db, {
      runId: sanitized.runId,
      taskId: sanitized.taskId,
      nodeId: node.id,
      signalKind: sanitized.signalKind,
    });
  }

  return { nodeId: node.id };
}

export async function recordLearningSignals(
  db: SouthstarDb,
  input: { actor: string; reason: string; signals: LearningSignalInput[] },
): Promise<{ nodeIds: string[] }> {
  const nodeIds: string[] = [];
  for (const signal of input.signals) {
    const recorded = await recordLearningSignal(db, {
      ...signal,
      captureActor: input.actor,
      captureReason: input.reason,
    });
    nodeIds.push(recorded.nodeId);
  }
  return { nodeIds };
}

async function runExists(db: SouthstarDb, runId: string): Promise<boolean> {
  return Boolean(await db.maybeOne("select 1 from southstar.workflow_runs where id = $1", [runId]));
}

async function appendSignalHistory(
  db: SouthstarDb,
  input: { runId: string; taskId?: string; nodeId: string; signalKind: string },
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const next = await tx.one<{ next_sequence: number }>(
      "select coalesce(max(sequence), 0) + 1 as next_sequence from southstar.workflow_history where run_id = $1",
      [input.runId],
    );
    await tx.query(
      `insert into southstar.workflow_history (
        id, run_id, task_id, sequence, event_type, actor_type, payload_json, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
      [
        randomUUID(),
        input.runId,
        input.taskId ?? null,
        next.next_sequence,
        "evolution.learning_signal_recorded",
        "southstar-evolution",
        JSON.stringify({ nodeId: input.nodeId, signalKind: input.signalKind }),
      ],
    );
  });
}

function signalSummary(input: LearningSignalInput): string {
  const pieces = [input.signalKind];
  if (typeof input.artifactType === "string") pieces.push(input.artifactType);
  if (typeof input.failureKind === "string") pieces.push(input.failureKind);
  return pieces.join(":");
}

function rejectUnsafeSignalPayload(value: unknown): void {
  const text = JSON.stringify(value);
  if (text.length > 64_000) throw new Error("learning signal payload is too large");
  if (/"rawTranscript"\s*:/.test(text) || /raw transcript/i.test(text)) {
    throw new Error("raw transcript payloads cannot be stored as learning signals");
  }
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return isSecretLike(value) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSecrets(nested)]));
  }
  return value;
}

function isSecretLike(value: string): boolean {
  return /\b(?:ghp|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_\-]{20,}\b/.test(value)
    || /\b[A-Za-z0-9_\-]{32,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/.test(value);
}
