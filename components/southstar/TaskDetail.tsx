"use client";

import {
  Check,
  ClipboardList,
  FileArchive,
  GitBranch,
  GitFork,
  History,
  KeyRound,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Split,
  TimerReset,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { TaskDetailView, TaskEnvelopeEvidenceView, UiRuntimeResourceView, UiTaskDetailPageView } from "./types";

type DetailSection = "context" | "overview" | "evaluator" | "session" | "artifacts";

export function TaskDetail(props: {
  task: TaskDetailView | null;
  envelope?: TaskEnvelopeEvidenceView | null;
  model?: UiTaskDetailPageView | null;
  onRetryTask?: () => void;
  onForkSession?: () => void;
  onResetSession?: () => void;
  onRollbackSession?: () => void;
  onRollbackWorkspace?: () => void;
  onPreviewWorktreeRollback?: () => void;
  onApplyWorktreeRollback?: () => void;
  onRequestWorkflowRevision?: () => void;
  onApproveMemory?: () => void;
  onRejectMemory?: () => void;
}) {
  const [activeSection, setActiveSection] = useState<DetailSection>("context");
  const task = props.task;
  const envelope = props.envelope ?? null;
  const packet = envelope?.contextPacket;
  const memoryCount = packet?.selectedMemories?.length ?? 0;
  const evaluatorCount = envelope?.evaluatorPipeline?.evaluatorRefs?.length ?? 0;
  const tokenCount = packet?.tokenEstimate?.total ?? 0;

  return (
    <section className="ss-panel ss-task-detail-panel" data-panel="task-detail" id="task-detail">
      <header className="ss-inspector-header">
        <div>
          <h2>Task Detail - {task ? taskLabel(task) : "No task selected"}</h2>
          {task ? <p>{envelope?.role?.name ?? envelope?.role?.id ?? packet?.roleRef ?? "role pending"} · {envelope?.agentProfile?.id ?? "agent pending"}</p> : null}
        </div>
        <span className={`ss-status-badge ss-status-${(task?.status ?? "idle").toLowerCase()}`}>{task?.status ?? "Idle"}</span>
      </header>

      {task ? (
        <>
          <div className="ss-task-highlight-strip" aria-label="task detail highlights">
            <HighlightTile icon={<ClipboardList size={14} aria-hidden />} tone="primary" label="Envelope" value={envelope?.schemaVersion ? "V2 wired" : "Pending"} />
            <HighlightTile icon={<History size={14} aria-hidden />} tone="primary" label="Memory" value={`${memoryCount} injected`} />
            <HighlightTile icon={<ShieldCheck size={14} aria-hidden />} tone="success" label="Gates" value={`${evaluatorCount || 4} checks`} />
            <HighlightTile icon={<TimerReset size={14} aria-hidden />} tone="neutral" label="Tokens" value={`${tokenCount} est.`} />
          </div>

          <div className="ss-task-detail-scroll">
            <div className="ss-task-section-shell">
              <nav className="ss-task-section-nav" aria-label="task detail sections">
                <SectionButton active={activeSection === "context"} icon={<History size={14} aria-hidden />} title="Context & Memory" meta={`${memoryCount} injected · ${tokenCount} tokens`} onClick={() => setActiveSection("context")} />
                <SectionButton active={activeSection === "overview"} icon={<ClipboardList size={14} aria-hidden />} title="Overview" meta={`${envelope?.role?.id ?? packet?.roleRef ?? "role"} · ${providerModel(envelope)}`} onClick={() => setActiveSection("overview")} />
                <SectionButton active={activeSection === "evaluator"} icon={<ShieldCheck size={14} aria-hidden />} title="Evaluator" meta={`${evaluatorCount || 4} checks`} onClick={() => setActiveSection("evaluator")} />
                <SectionButton active={activeSection === "session"} icon={<GitFork size={14} aria-hidden />} title="Session & Worktree" meta={envelope?.session?.sessionId ?? task.rootSessionId ?? "session pending"} onClick={() => setActiveSection("session")} />
                <SectionButton active={activeSection === "artifacts"} icon={<FileArchive size={14} aria-hidden />} title="Artifacts & Logs" meta={`${props.model?.artifacts.length ?? 0} artifacts · ${props.model?.logs.length ?? 0} events`} onClick={() => setActiveSection("artifacts")} />
              </nav>

              <div className="ss-task-section-content">
                {activeSection === "context" ? (
                  <SectionPanel title="Context & Memory Injection" meta={`${memoryCount} selected · ${packet?.excludedCandidates?.length ?? 0} excluded · ${tokenCount} tokens`} icon={<History size={15} aria-hidden />}>
                    <MemoryTrace packet={packet} />
                    <InfoCard title="ContextPacket" icon={<ScrollText size={14} aria-hidden />} rows={[
                      ["CP ID", packet?.id ?? "pending"],
                      ["Goal Slice", envelope?.intent ?? "pending"],
                      ["Token Budget", `${tokenCount} tokens`],
                      ["CP Trace", packet ? "Wired" : "Pending"],
                      ["Skill Instructions", String(packet?.skillInstructions?.length ?? 0)],
                      ["MCP Grant Summary", String(packet?.mcpGrantSummary?.length ?? 0)],
                    ]} />
                  </SectionPanel>
                ) : null}

                {activeSection === "overview" ? (
                  <SectionPanel title="Overview · TaskEnvelopeV2" meta={`${envelope?.role?.id ?? packet?.roleRef ?? "role pending"} · ${providerModel(envelope)}`} icon={<ClipboardList size={15} aria-hidden />}>
                    <InfoCard title="Execution Binding" icon={<KeyRound size={14} aria-hidden />} rows={[
                      ["Role", envelope?.role?.id ?? packet?.roleRef ?? "pending"],
                      ["Agent", envelope?.agentProfile?.id ?? "pending"],
                      ["Provider/Model", providerModel(envelope)],
                      ["Executor", envelope?.harness?.kind ?? task.executorTaskId ?? "pending binding"],
                      ["Timeout / Retries", envelope?.session?.maxRepairAttempts ? `30m / ${envelope.session.maxRepairAttempts}` : "30m / 2"],
                      ["Status", task.status],
                    ]} />
                    <InfoCard title="Capability Routing" icon={<Sparkles size={14} aria-hidden />} rows={[
                      ["Skills", listOrNone(envelope?.skills?.map((skill) => skill.skillId ?? skill.sourceRef))],
                      ["MCP Grants", listOrNone(envelope?.mcpGrants?.map((grant) => grant.serverId ?? "unknown"))],
                      ["Artifact Contract", listOrNone(envelope?.artifactContracts?.map((contract) => contract.id ?? contract.artifactType))],
                      ["Memory Scope", listOrNone(envelope?.agentProfile?.memoryScopes)],
                    ]} />
                  </SectionPanel>
                ) : null}

                {activeSection === "evaluator" ? (
                  <SectionPanel title="Evaluator & Stop Condition" meta={envelope?.evaluatorPipeline?.stopConditionRef ?? "All required checks must pass"} icon={<ShieldCheck size={15} aria-hidden />}>
                    <EvaluatorPanel envelope={envelope} model={props.model} />
                    <StopCondition envelope={envelope} />
                  </SectionPanel>
                ) : null}

                {activeSection === "session" ? (
                  <SectionPanel title="Session & Worktree" meta={`${envelope?.session?.sessionId ?? task.rootSessionId ?? "session pending"} · ${envelope?.workspace?.handle?.worktreePath ?? "worktree pending"}`} icon={<GitFork size={15} aria-hidden />}>
                    <SessionGraph
                      task={task}
                      envelope={envelope}
                      onForkSession={props.onForkSession}
                      onResetSession={props.onResetSession}
                      onRollbackSession={props.onRollbackSession}
                    />
                    <WorktreeConsole
                      envelope={envelope}
                      model={props.model}
                      onApplyWorktreeRollback={props.onApplyWorktreeRollback}
                      onPreviewWorktreeRollback={props.onPreviewWorktreeRollback}
                    />
                  </SectionPanel>
                ) : null}

                {activeSection === "artifacts" ? (
                  <SectionPanel title="Artifacts & Logs" meta={`${props.model?.artifacts.length ?? 0} artifacts · ${props.model?.logs.length ?? 0} events`} icon={<FileArchive size={15} aria-hidden />}>
                    <ArtifactPanel envelope={envelope} model={props.model} />
                    <LogPanel task={task} model={props.model} />
                  </SectionPanel>
                ) : null}
              </div>
            </div>
          </div>

          <section className="ss-ops-card">
            <h3><ShieldCheck size={14} aria-hidden /> Operations <span>{task.status}</span></h3>
            <div className="ss-operation-buttons">
              <button type="button" onClick={props.onRetryTask}><RotateCcw size={14} aria-hidden /> Retry Task</button>
              <button type="button" onClick={props.onForkSession}><GitFork size={14} aria-hidden /> Fork Session</button>
              <button type="button" className="ss-op-warn" onClick={props.onRollbackWorkspace}><Undo2 size={14} aria-hidden /> Rollback Workspace</button>
              <button type="button" onClick={props.onRequestWorkflowRevision}><Split size={14} aria-hidden /> Request Revision</button>
              <button type="button" className="ss-op-ok" onClick={props.onApproveMemory}><Check size={14} aria-hidden /> Approve Memory</button>
              <button type="button" className="ss-op-danger" onClick={props.onRejectMemory}><X size={14} aria-hidden /> Reject Memory</button>
            </div>
            <div className="ss-binding-warning">Session and Worktree operations require API binding. Configure API Bindings to enable.</div>
          </section>
        </>
      ) : (
        <p className="ss-empty">Select a workflow task to inspect TaskEnvelopeV2, ContextPacket, evaluator, artifact, session, memory, and worktree evidence.</p>
      )}
    </section>
  );
}

function HighlightTile(props: { tone: "primary" | "success" | "neutral"; icon: ReactNode; label: string; value: string }) {
  return (
    <div className={`ss-highlight-tile ss-tone-${props.tone}`}>
      <span>{props.icon}</span>
      <small>{props.label}</small>
      <strong>{props.value}</strong>
    </div>
  );
}

function SectionButton(props: {
  active: boolean;
  icon: ReactNode;
  title: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ss-section-button" aria-pressed={props.active} onClick={props.onClick}>
      <span>{props.icon}</span>
      <strong>{props.title}</strong>
      <small>{props.meta}</small>
    </button>
  );
}

function SectionPanel(props: { title: string; meta: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="ss-section-panel">
      <header>
        <span>{props.icon}</span>
        <div>
          <h3>{props.title}</h3>
          <p>{props.meta}</p>
        </div>
      </header>
      <div className="ss-section-panel-body">{props.children}</div>
    </section>
  );
}

function InfoCard(props: { title: string; icon?: ReactNode; rows: string[][] }) {
  return (
    <section className="ss-info-card">
      <h3>{props.icon}{props.title}</h3>
      <dl>
        {props.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MemoryTrace(props: { packet?: TaskEnvelopeEvidenceView["contextPacket"]; compact?: boolean }) {
  const selected = props.packet?.selectedMemories ?? [];
  return (
    <section className={`ss-info-card ss-memory-card ${props.compact ? "ss-memory-card-compact" : ""}`}>
      <h3><History size={14} aria-hidden /> Memory Injection Trace ({selected.length} injected)</h3>
      <table>
        <thead><tr><th>Memory ID</th><th>Type</th><th>Reason Injected</th><th>Relevance</th><th>Status</th></tr></thead>
        <tbody>
          {(selected.length > 0 ? selected : [{ id: "none", title: "No memory injected", sourceRef: "zero-selected", tokenEstimate: 0 }]).map((memory) => (
            <tr key={memory.id}>
              <td>{memory.id}</td>
              <td>{memory.sourceRef ?? "memory"}</td>
              <td>{memory.title}</td>
              <td>{typeof memory.tokenEstimate === "number" ? `${memory.tokenEstimate} tokens` : "-"}</td>
              <td>{memory.id === "none" ? "No-op" : "Injected"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(props.packet?.excludedCandidates?.length ?? 0) > 0 ? <p>{props.packet?.excludedCandidates?.length} Memory items not injected</p> : null}
    </section>
  );
}

function SessionGraph(props: {
  task: TaskDetailView;
  envelope: TaskEnvelopeEvidenceView | null;
  onForkSession?: () => void;
  onResetSession?: () => void;
  onRollbackSession?: () => void;
}) {
  const checkpoint = props.envelope?.session?.baseCheckpointId ?? "chk-1";
  const sessionId = props.envelope?.session?.sessionId ?? props.task.rootSessionId ?? "pending-session";
  return (
    <section className="ss-info-card ss-session-card">
      <h3><GitFork size={14} aria-hidden /> Session Graph <span>(Southstar DB)</span></h3>
      <div className="ss-session-lineage">
        <span>Root Session</span><span>{checkpoint}</span><span>fork</span><span>{props.task.id} current</span>
      </div>
      <label>Session: <select defaultValue={sessionId}><option>{sessionId}</option></select></label>
      <label>Reset to: <select defaultValue={checkpoint}><option>{checkpoint}</option></select></label>
      <div className="ss-session-actions">
        <button type="button" onClick={props.onForkSession}>Fork</button>
        <button type="button" onClick={props.onResetSession}>Reset</button>
        <button type="button" onClick={props.onRollbackSession}>Rollback</button>
      </div>
    </section>
  );
}

function WorktreeConsole(props: {
  envelope: TaskEnvelopeEvidenceView | null;
  model?: UiTaskDetailPageView | null;
  onApplyWorktreeRollback?: () => void;
  onPreviewWorktreeRollback?: () => void;
}) {
  const workspace = props.envelope?.workspace;
  const snapshot = workspace?.baseSnapshotRef;
  const previews = props.model?.worktree?.rollbackPreviews ?? [];
  const preview = previews[previews.length - 1];
  const previewPayload = payloadRecord(preview?.payload);
  const diff = typeof previewPayload.diffNameStatus === "string" && previewPayload.diffNameStatus.trim()
    ? previewPayload.diffNameStatus.trim().split("\n").slice(0, 3).join("; ")
    : "Preview required";
  return (
    <section className="ss-info-card ss-worktree-card">
      <h3><GitBranch size={14} aria-hidden /> Worktree Console <span>(Tork)</span></h3>
      <dl>
        <div><dt>Repo Snapshot</dt><dd>{snapshot?.repoRoot ?? workspace?.handle?.repoRoot ?? "pending"}</dd></div>
        <div><dt>Forked Worktree</dt><dd>{workspace?.handle?.worktreePath ?? "pending"}</dd></div>
        <div><dt>Base</dt><dd>{snapshot?.commitSha ?? snapshot?.ref ?? "pending"}</dd></div>
        <div><dt>Diff Preview</dt><dd>{diff}</dd></div>
      </dl>
      <div className="ss-worktree-actions">
        <button type="button" onClick={props.onApplyWorktreeRollback}><Undo2 size={13} aria-hidden /> Rollback</button>
        <button type="button" onClick={props.onPreviewWorktreeRollback}>Preview</button>
      </div>
    </section>
  );
}

function EvaluatorPanel(props: { envelope: TaskEnvelopeEvidenceView | null; model?: UiTaskDetailPageView | null; compact?: boolean }) {
  const evaluators = props.envelope?.evaluatorPipeline?.evaluatorRefs ?? ["Unit Tests", "README Evidence", "Artifact Contract", "Stop Condition"];
  const resultByTitle = new Map((props.model?.evaluator.results ?? []).map((result) => [result.title ?? result.resourceKey ?? result.id ?? "", result.status ?? "recorded"]));
  return (
    <section className={`ss-info-card ${props.compact ? "ss-evaluator-card" : ""}`}>
      <h3><ShieldCheck size={14} aria-hidden /> Evaluator Pipeline</h3>
      <ol>
        {evaluators.map((item, index) => <li key={item}>{index + 1}. {item} <span>{resultByTitle.get(item) ?? "Pending"}</span></li>)}
      </ol>
    </section>
  );
}

function ArtifactPanel(props: { envelope: TaskEnvelopeEvidenceView | null; model?: UiTaskDetailPageView | null }) {
  const artifacts = props.model?.artifacts ?? [];
  if (artifacts.length > 0) {
    return <InfoCard title="Artifacts" icon={<FileArchive size={14} aria-hidden />} rows={artifacts.map((artifact) => [artifact.title ?? artifact.id ?? "artifact", artifact.status ?? "recorded"])} />;
  }
  return (
    <InfoCard title="Artifact Contracts" icon={<FileArchive size={14} aria-hidden />} rows={(props.envelope?.artifactContracts ?? []).map((contract) => [
      contract.id ?? contract.artifactType ?? "artifact",
      listOrNone(contract.requiredFields),
    ])} />
  );
}

function LogPanel(props: { task: TaskDetailView; model?: UiTaskDetailPageView | null }) {
  const logs = props.model?.logs ?? [];
  if (logs.length > 0) {
    return <InfoCard title="Task Runtime Logs" icon={<History size={14} aria-hidden />} rows={logs.slice(-8).map((log) => [log.eventType ?? `event-${log.sequence ?? "unknown"}`, compactJson(log.payload)])} />;
  }
  return <InfoCard title="Task Runtime Evidence" icon={<History size={14} aria-hidden />} rows={[
    ["Snapshot", compactJson(props.task.snapshot)],
    ["Metrics", compactJson(props.task.metrics)],
    ["Dependencies", props.task.dependsOn.length > 0 ? props.task.dependsOn.join(", ") : "none"],
  ]} />;
}

function StopCondition(props: { envelope: TaskEnvelopeEvidenceView | null }) {
  return (
    <section className="ss-info-card ss-stop-card">
      <h3><ShieldCheck size={14} aria-hidden /> Stop Condition <span>(Gate)</span></h3>
      <p>{props.envelope?.evaluatorPipeline?.stopConditionRef ?? "All required checks must pass."}</p>
    </section>
  );
}

function taskLabel(task: TaskDetailView): string {
  return `${task.id} ${task.taskKey}`;
}

function providerModel(envelope: TaskEnvelopeEvidenceView | null): string {
  const profile = envelope?.agentProfile;
  if (!profile) return "pending model policy";
  return [profile.provider, profile.model].filter(Boolean).join(" / ") || "domain policy";
}

function listOrNone(values: Array<string | undefined> | undefined): string {
  const filtered = (values ?? []).filter((value): value is string => Boolean(value));
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value ?? {});
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
