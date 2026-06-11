import { inspectIssueSnapshot } from "../orchestrator/inspect.ts";
import { redactSecrets } from "../runtime/redaction.ts";
import { lifecycleStates, type HistoryEntry, type IssueSnapshot, type LifecycleState } from "../types/control-plane.ts";
import type { HostAdapterName } from "../config/schema.ts";
import type {
  DashboardReadInput,
  NorthstarArtifactSummary,
  NorthstarBoard,
  NorthstarBoardCard,
  NorthstarIssueDetail,
  NorthstarOperatorActionDescriptor,
  NorthstarProjectSummary,
  NorthstarRunEvent,
  NorthstarSessionLink,
} from "./models.ts";

export interface NorthstarIssueDetailReadInput {
  project: NorthstarProjectSummary;
  snapshot: IssueSnapshot;
  history: HistoryEntry[];
  now: string;
}

const hostAdapters = new Set<HostAdapterName>(["codex", "opencode", "pi"]);
const maxAcceptedArtifacts = 20;

export function buildNorthstarBoard(input: DashboardReadInput): NorthstarBoard {
  const groups = lifecycleStates.map((lifecycle) => ({
    lifecycle,
    cards: input.issues
      .filter((snapshot) => snapshot.lifecycle_state === lifecycle)
      .map((snapshot) => issueCardForSnapshot(snapshot, input.historiesByIssueId.get(snapshot.issue_id) ?? [])),
  }));

  return {
    project: input.project,
    groups,
  };
}

export function buildNorthstarIssueDetail(input: NorthstarIssueDetailReadInput): NorthstarIssueDetail {
  const packet = issuePacket(input.snapshot);
  return {
    snapshot: redactSecrets(input.snapshot),
    title: stringValue(packet.title) ?? input.snapshot.issue_id,
    sourceUrl: stringValue(packet.source_url ?? packet.sourceUrl),
    labels: stringArray(packet.labels),
    inspect: redactSecrets(inspectIssueSnapshot(input.snapshot, input.history)) as unknown as Record<string, unknown>,
    timeline: input.history.map(runEventForHistory),
    sessionLinks: sessionLinksForSnapshot(input.snapshot),
    acceptedArtifacts: acceptedArtifactsForHistory(input.history),
    availableActions: availableActionsForSnapshot(input.snapshot, input.history),
  };
}

export function runEventForHistory(entry: HistoryEntry): NorthstarRunEvent {
  return {
    id: String(entry.id ?? entry.sequence ?? entry.event_type),
    sequence: entry.sequence ?? 0,
    eventType: entry.event_type,
    severity: eventSeverity(entry.event_type),
    createdAt: entry.created_at ?? null,
    summary: eventSummary(entry),
    payloadPreview: compactPayloadPreview(maskSecretPrefixes(entry.payload)),
  };
}

function issueCardForSnapshot(snapshot: IssueSnapshot, history: HistoryEntry[]): NorthstarBoardCard {
  const packet = issuePacket(snapshot);
  const inspect = inspectIssueSnapshot(snapshot, history);
  const latestRun = [...(snapshot.runtime_context_json.child_runs ?? [])].at(-1);
  const activeStream = activeStreamRun(snapshot);
  return {
    issueId: snapshot.issue_id,
    issueNumber: stringValue(packet.issue_number ?? packet.issueNumber),
    title: stringValue(packet.title) ?? snapshot.issue_id,
    lifecycle: snapshot.lifecycle_state,
    currentStage: stringValue(snapshot.runtime_context_json.stage_cursor ?? snapshot.runtime_context_json.current_stage),
    latestHostAdapter: latestHostAdapter(snapshot),
    dependencyCount: arrayValue(packet.dependencies).length,
    blocked: isBlocked(snapshot),
    prUrl: inspect.pr_url,
    mergeSha: inspect.merge_sha,
    latestRootSessionId: latestRun?.root_session_id ?? null,
    latestChildRunId: latestRun?.child_run_id ?? null,
    activeStreamAdapter: activeStream?.adapter ?? null,
    activeStreamSessionId: activeStream?.sessionId ?? null,
    activeStreamChildRunId: activeStream?.childRunId ?? null,
    lastHeartbeatAt: latestRun?.last_seen_at ?? inspect.last_heartbeat,
    nextRecommendedAction: nextRecommendedAction(snapshot.lifecycle_state, history, snapshot.runtime_context_json.projection_sync ?? []),
    projectionFailure: projectionFailure(snapshot),
  };
}

function nextRecommendedAction(lifecycle: LifecycleState, history: HistoryEntry[], projectionSync: Array<Record<string, unknown>>): string {
  if (lifecycle === "completed" || lifecycle === "cancelled") return "none";
  if (lifecycle === "quarantined") return "resume";
  if (latestRetryableProjectionStatus(projectionSync) || latestRetryableEffectStatus(history)) return "retry-sync";
  if (lifecycle === "ready") return "start";
  if (lifecycle === "claimed" || lifecycle === "running" || lifecycle === "verifying" || lifecycle === "releasing") return "reconcile";
  if (lifecycle === "release_pending") return "approve-release";
  if (lifecycle === "verified") return "release";
  if (lifecycle === "failed") return "inspect";
  return "inspect";
}

function availableActionsForSnapshot(snapshot: IssueSnapshot, history: HistoryEntry[]): NorthstarOperatorActionDescriptor[] {
  const recommendation = nextRecommendedAction(snapshot.lifecycle_state, history, snapshot.runtime_context_json.projection_sync ?? []);
  if (recommendation === "approve-release") {
    return [{
      action: "release",
      label: "Approve Release",
      requiresConfirmation: true,
      style: "primary",
    }];
  }
  return [];
}

function latestRetryableProjectionStatus(projectionSync: Array<Record<string, unknown>>): boolean {
  const latestByTarget = new Map<string, string>();
  for (const row of projectionSync) {
    const status = stringValue(row.status);
    if (!status) continue;
    latestByTarget.set(projectionStatusKey(row), status);
  }
  return [...latestByTarget.values()].some((status) => status === "failed" || status === "retryable");
}

function latestRetryableEffectStatus(history: HistoryEntry[]): boolean {
  const latestByEffect = new Map<string, string>();
  for (const entry of history) {
    if (entry.event_type !== "effect_failed_retryable" && entry.event_type !== "effect_result" && entry.event_type !== "project_projection_synced") {
      continue;
    }
    const status = stringValue(entry.payload.status) ?? (entry.event_type === "effect_failed_retryable" ? "retryable" : null);
    if (!status) continue;
    latestByEffect.set(effectStatusKey(entry.payload), status);
  }
  return [...latestByEffect.values()].some((status) => status === "failed" || status === "retryable");
}

function projectionStatusKey(row: Record<string, unknown>): string {
  return stringValue(row.projection_target ?? row.target ?? row.effect_type) ?? "__global__";
}

function effectStatusKey(payload: Record<string, unknown>): string {
  const idempotencyKey = stringValue(payload.idempotency_key);
  return stringValue(payload.effect_id ?? payload.projection_target ?? payload.effect_type) ??
    idempotencyKey?.split(":").slice(0, 2).join(":") ??
    "__global__";
}

function projectionFailure(snapshot: IssueSnapshot): boolean {
  return latestRetryableProjectionStatus(snapshot.runtime_context_json.projection_sync ?? []);
}

function latestHostAdapter(snapshot: IssueSnapshot): HostAdapterName | null {
  const host = [...(snapshot.runtime_context_json.child_runs ?? [])].at(-1)?.capability_report?.host;
  return host && hostAdapters.has(host) ? host : null;
}

function activeStreamRun(snapshot: IssueSnapshot): { adapter: HostAdapterName; sessionId: string; childRunId: string } | null {
  const runs = snapshot.runtime_context_json.child_runs ?? [];
  const lease = snapshot.runtime_context_json.owner_lease;
  const candidates = lease
    ? [
        ...runs.filter((run) => run.lease_id === lease.lease_id),
        ...runs.filter((run) => run.role === lease.role),
      ]
    : [...runs].reverse();

  for (const run of candidates) {
    const sessionId = stringValue(run.stream_session_id);
    const adapter = streamAdapterForRun(run);
    if (sessionId && adapter) {
      return { adapter, sessionId, childRunId: run.child_run_id };
    }
  }

  return null;
}

function sessionLinksForSnapshot(snapshot: IssueSnapshot): NorthstarSessionLink[] {
  return (snapshot.runtime_context_json.child_runs ?? []).flatMap((run) => {
    const streamAdapter = streamAdapterForRun(run);
    const host = streamAdapter ?? run.capability_report?.host;
    if (!host || !hostAdapters.has(host)) return [];
    const streamSessionId = stringValue(run.stream_session_id);
    return [{
      host,
      rootSessionId: run.root_session_id,
      childRunId: run.child_run_id,
      sessionId: run.session_id,
      streamAdapter,
      streamSessionId,
      href: host === "pi" ? `/?session=${encodeURIComponent(streamSessionId ?? run.session_id)}` : null,
    }];
  });
}

function streamAdapterForRun(run: NonNullable<IssueSnapshot["runtime_context_json"]["child_runs"]>[number]): HostAdapterName | null {
  const adapter = run.stream_adapter ?? run.capability_report?.host;
  return adapter && hostAdapters.has(adapter) ? adapter : null;
}

function acceptedArtifactsForHistory(history: HistoryEntry[]): NorthstarArtifactSummary[] {
  const artifactsByHistoryId = new Map(
    history.map((entry) => [entry.id ?? entry.sequence ?? 0, entry] as const),
  );

  return history.flatMap((entry): NorthstarArtifactSummary[] => {
    if (entry.event_type !== "child_artifact_received") return [];
    const status = stringValue(entry.payload.status);
    if (status !== "succeeded" && status !== "success" && status !== "pass") return [];
    const artifactHistoryId = entry.payload.artifact_history_id;
    const artifactHistoryIdNumber = numberValue(artifactHistoryId);
    const artifactEntry = artifactHistoryIdNumber === null ? undefined : artifactsByHistoryId.get(artifactHistoryIdNumber);
    const kind = artifactKindForReceipt(entry, artifactEntry, artifactHistoryIdNumber);
    const summary = artifactSummaryForReceipt(entry, artifactEntry, artifactHistoryIdNumber);
    const historyId = entry.id ?? entry.sequence ?? 0;
    return [{
      historyId,
      artifactHistoryId: artifactHistoryIdNumber ?? historyId,
      artifact_history_id: artifactHistoryId,
      kind,
      summary,
    }];
  }).slice(-maxAcceptedArtifacts);
}

function artifactKindForReceipt(entry: HistoryEntry, artifactEntry: HistoryEntry | undefined, artifactHistoryId: number | null): string {
  if (artifactEntry) {
    return stringValue(artifactEntry.payload.artifact_kind ?? artifactEntry.payload.kind) ?? "artifact";
  }
  if (artifactHistoryId !== null) return "artifact";
  return stringValue(entry.payload.artifact_kind ?? entry.payload.kind) ?? "artifact";
}

function artifactSummaryForReceipt(entry: HistoryEntry, artifactEntry: HistoryEntry | undefined, artifactHistoryId: number | null): string {
  if (artifactEntry) {
    const compact = compactPayloadPreview(maskSecretPrefixes(artifactEntry.payload));
    return boundedRedactedString(artifactEntry.payload.summary) ?? boundedRedactedString(JSON.stringify(compact)) ?? "artifact";
  }
  if (artifactHistoryId !== null) return `artifact history ${artifactHistoryId}`;
  const compact = compactPayloadPreview(maskSecretPrefixes(entry.payload));
  return boundedRedactedString(entry.payload.summary) ?? boundedRedactedString(JSON.stringify(compact)) ?? "artifact";
}

function eventSeverity(eventType: string): NorthstarRunEvent["severity"] {
  if (/failed|quarantine|violation/.test(eventType)) return "error";
  if (/retry|blocked|stale/.test(eventType)) return "warning";
  return "info";
}

function eventSummary(entry: HistoryEntry): string {
  const summary = boundedRedactedString(entry.payload.summary ?? entry.payload.message ?? entry.payload.last_error);
  return summary ?? entry.event_type.replaceAll("_", " ");
}

const rawContentFields = new Set([
  "raw_transcript",
  "terminal_log",
  "raw_browser_trace",
  "full_log",
  "transcript",
  "raw_session_jsonl",
]);

function compactPayloadPreview(value: unknown): unknown {
  const redacted = redactSecrets(value);
  if (redacted === null || redacted === undefined) return redacted;
  if (typeof redacted === "string") {
    return redacted.length > 500 ? `${redacted.slice(0, 500)}...[truncated]` : redacted;
  }
  if (typeof redacted !== "object") return redacted;
  if (Array.isArray(redacted)) {
    return redacted.slice(0, 10).map((item) => compactPayloadPreview(item));
  }

  return Object.fromEntries(
    Object.entries(redacted as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 20)
      .map(([key, nested]) => [
        key,
        rawContentFields.has(key.toLowerCase()) ? "[redacted raw content]" : compactPayloadPreview(nested),
      ]),
  );
}

function boundedRedactedString(value: unknown): string | null {
  const redacted = stringValue(maskSecretPrefixes(redactSecrets(value)));
  if (!redacted) return null;
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...[truncated]` : redacted;
}

function maskSecretPrefixes<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\b(ghp|gho|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_=-]{8,}\b/g, "$1_***") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskSecretPrefixes(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, maskSecretPrefixes(nested)]),
    ) as T;
  }
  return value;
}

function issuePacket(snapshot: IssueSnapshot): Record<string, unknown> {
  const packet = snapshot.runtime_context_json.issue_packet;
  return packet && typeof packet === "object" && !Array.isArray(packet) ? packet as Record<string, unknown> : {};
}

function isBlocked(snapshot: IssueSnapshot): boolean {
  return arrayValue(snapshot.runtime_context_json.blocked_by).length > 0 ||
    (snapshot.runtime_context_json.child_runs ?? []).some((run) => run.status === "blocked");
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).map((item) => String(item));
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
