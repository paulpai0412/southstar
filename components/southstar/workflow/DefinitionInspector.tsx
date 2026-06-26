import { useState } from "react";
import type { WorkflowTaskNodeModel } from "../workflow-canvas/types";

export function DefinitionInspector(props: {
  task: WorkflowTaskNodeModel | null;
  inspector: any | null;
  plannerRationale: string | null;
  validationIssues: Array<{ path: string; message: string; code?: string }>;
  repairAttempts: number;
  repairAttemptDetails?: unknown[];
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
  const roleDefinition = recordValue(inspectorTask.roleDefinition);
  const agentProfile = recordValue(inspectorTask.agentProfile);
  const vaultPolicy = recordValue(inspectorTask.vaultPolicy);
  const artifactContract = recordValue(inspectorTask.artifactContract);
  const evaluatorPipeline = recordValue(inspectorTask.evaluatorPipeline);
  const contextPolicy = recordValue(inspectorTask.contextPolicy);
  const plannerTraceRows = traceRows(props.plannerTraceRefs);
  const repairRows = repairAttemptRows(props.repairAttemptDetails);
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
        <div><dt>Attention</dt><dd>{attentionText(attention)}</dd></div>
      </dl>
      <h3>Role definition</h3>
      <DefinitionRows rows={[
        ["id", stringValue(roleDefinition.id) ?? roleRef],
        ["responsibility", stringValue(roleDefinition.responsibility)],
        ["default profile", stringValue(roleDefinition.defaultAgentProfileRef)],
        ["artifact outputs", stringArray(roleDefinition.artifactOutputs).join(", ")],
        ["stop authority", stringValue(roleDefinition.stopAuthority)],
      ]} empty="No role definition in read model." />
      <h3>Agent profile</h3>
      <DefinitionRows rows={[
        ["id", stringValue(agentProfile.id) ?? profileRef],
        ["name", stringValue(agentProfile.name)],
        ["provider", stringValue(agentProfile.provider)],
        ["model", stringValue(agentProfile.model)],
        ["context policy", stringValue(agentProfile.contextPolicyRef)],
        ["allowed tools", stringArray(recordValue(agentProfile.toolPolicy).allowedTools).join(", ")],
        ["denied tools", stringArray(recordValue(agentProfile.toolPolicy).deniedTools).join(", ")],
      ]} empty="No agent profile detail in read model." />
      <h3>Skills / MCP</h3>
      <p>{skillRefs.join(", ") || "No skill refs in read model."}</p>
      <p>{mcpGrantRefs.join(", ") || "No MCP grants in read model."}</p>
      <p>{toolGrantRefs.join(", ") || "No tool grants in read model."}</p>
      <h3>Vault policy</h3>
      <DefinitionRows rows={[
        ["id", stringValue(vaultPolicy.id)],
        ["name", stringValue(vaultPolicy.displayName)],
        ["lease ttl", numberValue(vaultPolicy.leaseTtlSeconds)],
        ["audit required", booleanValue(vaultPolicy.auditRequired)],
      ]} empty="No vault policy in read model." />
      <h3>Artifact contract</h3>
      <DefinitionRows rows={[
        ["id", stringValue(artifactContract.id)],
        ["type", stringValue(artifactContract.artifactType)],
        ["required fields", stringArray(artifactContract.requiredFields).join(", ")],
        ["evidence fields", stringArray(artifactContract.evidenceFields).join(", ")],
      ]} empty="No artifact contract in read model." />
      <h3>Evaluator pipeline</h3>
      <DefinitionRows rows={[
        ["id", stringValue(evaluatorPipeline.id)],
        ["evaluators", evaluatorLabels(evaluatorPipeline.evaluators).join(", ")],
        ["failure strategy", stringValue(recordValue(evaluatorPipeline.onFailure).defaultStrategy)],
      ]} empty="No evaluator pipeline in read model." />
      <h3>Context policy</h3>
      <DefinitionRows rows={[
        ["id", stringValue(contextPolicy.id)],
        ["max input tokens", numberValue(contextPolicy.maxInputTokens)],
        ["memory policy", stringValue(contextPolicy.memoryPolicyRef)],
        ["include AGENTS.md", booleanValue(contextPolicy.includeAgentsMd)],
        ["include workspace summary", booleanValue(contextPolicy.includeWorkspaceSummary)],
      ]} empty="No context policy in read model." />
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
      {repairRows.length > 0 ? (
        <ul>
          {repairRows.map((row, index) => <li key={`${row}-${index}`}>{row}</li>)}
        </ul>
      ) : null}
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

function DefinitionRows(props: { rows: Array<[string, string | undefined]>; empty: string }) {
  const rows = props.rows.filter((row): row is [string, string] => Boolean(row[1]));
  if (rows.length === 0) return <p>{props.empty}</p>;
  return (
    <dl>
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function booleanValue(value: unknown): string | undefined {
  return typeof value === "boolean" ? String(value) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function attentionText(value: unknown): string {
  const attention = recordValue(value);
  const reason = stringValue(attention.reason);
  const severity = stringValue(attention.severity);
  if (reason && severity) return `${severity}: ${reason}`;
  if (reason) return reason;
  return stringValue(value) ?? "none";
}

function evaluatorLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => recordValue(entry))
    .map((entry) => [stringValue(entry.id), stringValue(entry.kind), booleanValue(entry.required)].filter(Boolean).join(" "))
    .filter((entry) => entry.length > 0);
}

function repairAttemptRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => recordValue(entry))
    .map((entry) => [
      numberValue(entry.attempt) ?? stringValue(entry.attempt),
      stringValue(entry.status),
      stringValue(entry.reason),
      stringValue(entry.traceRef),
    ].filter(Boolean).join(" · "))
    .filter((entry) => entry.length > 0);
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
