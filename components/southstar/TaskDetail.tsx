import type { TaskDetailView, TaskEnvelopeEvidenceView } from "./types";

export function TaskDetail(props: { task: TaskDetailView | null; envelope?: TaskEnvelopeEvidenceView | null }) {
  const task = props.task;
  const envelope = props.envelope ?? null;
  const packet = envelope?.contextPacket;
  return (
    <section className="ss-panel" data-panel="task-detail" id="task-detail">
      <header>
        <h2>Task Detail</h2>
        <span>{task?.status ?? "No task selected"}</span>
      </header>
      {task ? (
        <dl>
          <dt>Task</dt>
          <dd>{task.taskKey}</dd>
          <dt>Dependencies</dt>
          <dd>{task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}</dd>
          <dt>Session</dt>
          <dd>{task.rootSessionId ?? "pending checkpoint"}</dd>
          <dt>Executor</dt>
          <dd>{task.executorTaskId ?? "pending binding"}</dd>
          <dt>Snapshot</dt>
          <dd>{compactJson(task.snapshot)}</dd>
          <dt>Metrics</dt>
          <dd>{compactJson(task.metrics)}</dd>
          <dt>TaskEnvelopeV2</dt>
          <dd>{envelope ? `${envelope.schemaVersion} · ${envelope.domain}/${envelope.intent}` : "pending envelope"}</dd>
          <dt>ContextPacket</dt>
          <dd>{packet ? `${packet.id} · ${packet.tokenEstimate?.total ?? 0} tokens` : "pending context packet"}</dd>
          <dt>Agent</dt>
          <dd>{agentSummary(envelope)}</dd>
          <dt>Skills</dt>
          <dd>{listOrNone(envelope?.skills?.map((skill) => skill.skillId ?? skill.sourceRef))}</dd>
          <dt>MCP</dt>
          <dd>{listOrNone(envelope?.mcpGrants?.map((grant) => `${grant.serverId ?? "unknown"}:${grant.allowedTools?.join("|") ?? "*"}`))}</dd>
          <dt>Memory Injection</dt>
          <dd>{memorySummary(envelope)}</dd>
          <dt>Evaluator</dt>
          <dd>{evaluatorSummary(envelope)}</dd>
          <dt>Workspace</dt>
          <dd>{workspaceSummary(envelope)}</dd>
        </dl>
      ) : (
        <p className="ss-empty">Select a workflow task to inspect runtime evidence.</p>
      )}
    </section>
  );
}

function agentSummary(envelope: TaskEnvelopeEvidenceView | null): string {
  if (!envelope) return "pending agent profile";
  const profile = envelope.agentProfile;
  const role = envelope.role?.id ?? envelope.contextPacket?.roleRef ?? "unknown-role";
  return [
    role,
    profile?.id,
    profile?.provider,
    profile?.model,
    envelope.harness?.kind,
  ].filter(Boolean).join(" · ");
}

function memorySummary(envelope: TaskEnvelopeEvidenceView | null): string {
  const packet = envelope?.contextPacket;
  if (!packet) return "pending memory trace";
  const selected = packet.selectedMemories ?? [];
  const excluded = packet.excludedCandidates ?? [];
  const selectedRefs = selected.map((memory) => memory.sourceRef ?? memory.title);
  const excludedRefs = excluded.map((candidate) => `${candidate.sourceRef}:${candidate.reason}`);
  return `selected ${selected.length} [${listOrNone(selectedRefs)}] · excluded ${excluded.length} [${listOrNone(excludedRefs)}]`;
}

function evaluatorSummary(envelope: TaskEnvelopeEvidenceView | null): string {
  const pipeline = envelope?.evaluatorPipeline;
  if (!pipeline) return "pending evaluator";
  return [
    pipeline.id,
    `evaluators=${listOrNone(pipeline.evaluatorRefs)}`,
    `stop=${pipeline.stopConditionRef ?? "domain default"}`,
    `contracts=${listOrNone(envelope?.artifactContracts?.map((contract) => contract.id ?? contract.artifactType))}`,
  ].filter(Boolean).join(" · ");
}

function workspaceSummary(envelope: TaskEnvelopeEvidenceView | null): string {
  const workspace = envelope?.workspace;
  if (!workspace) return "pending workspace snapshot";
  const snapshot = workspace.baseSnapshotRef;
  return [
    workspace.handle?.worktreePath ?? workspace.handle?.repoRoot,
    snapshot?.provider,
    snapshot?.commitSha,
    snapshot?.ref,
  ].filter(Boolean).join(" · ") || "workspace handle ready";
}

function listOrNone(values: Array<string | undefined> | undefined): string {
  const filtered = (values ?? []).filter((value): value is string => Boolean(value));
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value ?? {});
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}
