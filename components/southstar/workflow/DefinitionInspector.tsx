import { useState } from "react";
import type { WorkflowTaskNodeModel } from "../workflow-canvas/types";

export function DefinitionInspector(props: {
  task: WorkflowTaskNodeModel | null;
  inspector: any | null;
  plannerRationale: string | null;
  validationIssues: Array<{ path: string; message: string; code?: string }>;
  repairAttempts: number;
  plannerTraceRefs: Record<string, unknown> | null;
  onRunDraft: () => void;
  onReviseDraft: (prompt: string) => void;
  runDisabled: boolean;
  running: boolean;
  reviseDisabled: boolean;
  revising: boolean;
}) {
  const inspectorTask = props.inspector ?? {};
  const taskId = props.task?.id ?? inspectorTask.taskId ?? "Select task";
  const roleRef = props.task?.roleRef ?? inspectorTask.agentDefinitionRef ?? "role:auto";
  const profileRef = props.task?.agentProfileRef ?? inspectorTask.agentProfileRef ?? "profile:auto";
  const artifactKind = props.task?.artifactKind ?? inspectorTask.artifactKind ?? "implementation_report";
  const badges = props.task?.badges ?? [];
  const attention = props.task?.attention ?? inspectorTask.attention ?? null;
  const skillRefs = stringArray(inspectorTask.skillRefs ?? inspectorTask.materializedLibraryRefs?.skillRefs);
  const mcpGrantRefs = stringArray(inspectorTask.mcpGrantRefs ?? inspectorTask.materializedLibraryRefs?.mcpGrantRefs);
  const toolGrantRefs = stringArray(inspectorTask.toolGrantRefs ?? inspectorTask.materializedLibraryRefs?.toolGrantRefs);
  const plannerTraceRows = traceRows(props.plannerTraceRefs);
  const [revisePrompt, setRevisePrompt] = useState("");

  return (
    <aside className="ss-task-inspector">
      <header>
        <h2>Definition Inspector</h2>
      </header>
      <dl>
        <div><dt>Task</dt><dd>{taskId}</dd></div>
        <div><dt>Role</dt><dd>{roleRef}</dd></div>
        <div><dt>Profile</dt><dd>{profileRef}</dd></div>
        <div><dt>Artifact</dt><dd>{artifactKind}</dd></div>
        <div><dt>Badges</dt><dd>{badges.map((badge) => badge.label).join(", ") || "none"}</dd></div>
        <div><dt>Attention</dt><dd>{attention || "none"}</dd></div>
      </dl>
      <h3>Skills / MCP</h3>
      <p>{skillRefs.join(", ") || "No skill refs in read model."}</p>
      <p>{mcpGrantRefs.join(", ") || "No MCP grants in read model."}</p>
      <p>{toolGrantRefs.join(", ") || "No tool grants in read model."}</p>
      <h3>Planner rationale</h3>
      <p>{props.plannerRationale ?? "No rationale yet."}</p>
      <h3>Validation issues</h3>
      {props.validationIssues.length === 0 ? <p>No validation issues.</p> : (
        <ul>
          {props.validationIssues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              <strong>{issue.path}</strong>: {issue.message}{issue.code ? ` (${issue.code})` : ""}
            </li>
          ))}
        </ul>
      )}
      <h3>Repair attempts</h3>
      <p>{props.repairAttempts}</p>
      <h3>Planner trace refs</h3>
      {plannerTraceRows.length === 0 ? <p>No planner trace refs in read model.</p> : (
        <ul>
          {plannerTraceRows.map((row) => (
            <li key={row.key}><strong>{row.key}</strong>: {row.value}</li>
          ))}
        </ul>
      )}
      <label htmlFor="workflow-revise-prompt">Revise prompt</label>
      <textarea id="workflow-revise-prompt" value={revisePrompt} onChange={(event) => setRevisePrompt(event.currentTarget.value)} />
      <button
        type="button"
        onClick={() => props.onReviseDraft(revisePrompt)}
        disabled={props.reviseDisabled || props.revising || revisePrompt.trim().length === 0}
      >
        {props.revising ? "Revising…" : "Revise draft"}
      </button>
      <button type="button" onClick={props.onRunDraft} disabled={props.runDisabled || props.running}>
        {props.running ? "Starting run…" : "Run workflow"}
      </button>
    </aside>
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function traceRows(trace: Record<string, unknown> | null): Array<{ key: string; value: string }> {
  if (!trace) return [];
  return Object.entries(trace)
    .map(([key, value]) => ({
      key,
      value: typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value),
    }));
}
