import React from "react";

type WorkflowNodeLike = {
  id: string;
  label?: string;
  roleRef?: string | null;
  agentProfileRef?: string | null;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
  toolGrantRefs?: string[];
};

type RecordRow = Record<string, unknown>;

export function AgentLibraryPanel(props: {
  model: any | null;
  activeCwd: string | null;
  selectedTaskId: string | null;
  onOpenAlternatives: () => void;
  alternativesDisabled: boolean;
}) {
  const agentLibrarySummary = asRecord(props.model?.agentLibrarySummary);
  const agentLibrary = readAgentLibrary(props.model);
  const canvasModel = asRecord(props.model?.canvasModel);
  const nodes = (Array.isArray(canvasModel?.nodes) ? canvasModel.nodes : props.model?.draft?.dag?.nodes ?? []) as WorkflowNodeLike[];
  const selected = nodes.find((node) => node.id === props.selectedTaskId) ?? null;
  const selectedDefinition = asRecord(props.model?.selectedDefinition ?? props.model?.draft?.taskInspector);
  const selectionReasons = stringArray(
    props.model?.selectionReasons
    ?? props.model?.candidateReasons
    ?? props.model?.agentSelectionReasons
    ?? props.model?.draft?.selectionReasons,
  );
  const contextMemoryRefs = stringArray(
    props.model?.contextMemory?.refs
    ?? props.model?.contextMemoryRefs
    ?? props.model?.runtimeContext?.contextMemoryRefs
    ?? props.model?.runtimeContext?.knowledgeCardRefs,
  );
  const selectedSkillRefs = stringArray(selectedDefinition?.skillRefs ?? selected?.skillRefs);
  const selectedMcpGrantRefs = stringArray(selectedDefinition?.mcpGrantRefs ?? selected?.mcpGrantRefs);
  const selectedToolGrantRefs = stringArray(selectedDefinition?.toolGrantRefs ?? selected?.toolGrantRefs);
  const policyRoleRef = stringValue(selectedDefinition?.roleRef ?? selected?.roleRef);
  const policyProfileRef = stringValue(selectedDefinition?.agentProfileRef ?? selected?.agentProfileRef);
  const roles = recordArray(agentLibrary?.roles);
  const profiles = recordArray(agentLibrary?.agentProfiles);
  const skills = recordArray(agentLibrary?.skills);
  const mcpServers = recordArray(agentLibrary?.mcpServers);
  const tools = recordArray(agentLibrary?.tools);
  const artifactContracts = recordArray(agentLibrary?.artifactContracts);
  const evaluatorPipelines = recordArray(agentLibrary?.evaluatorPipelines);
  const contextPolicies = recordArray(agentLibrary?.contextPolicies);
  const sessionPolicies = recordArray(agentLibrary?.sessionPolicies);
  const memoryPolicies = recordArray(agentLibrary?.memoryPolicies);
  const workspacePolicies = recordArray(agentLibrary?.workspacePolicies);
  const vaultPolicies = recordArray(agentLibrary?.vaultLeasePolicies ?? agentLibrary?.vaultPolicies);

  return (
    <aside className="ss-library-context">
      <h2>Agent Library</h2>
      <section>
        <h3>Domain Pack</h3>
        <p>{stringValue(agentLibrary?.domain ?? agentLibrarySummary?.domain) ?? "unknown"}</p>
        {stringValue(props.model?.agentLibraryError) ? <p>Agent Library degraded: {stringValue(props.model?.agentLibraryError)}</p> : null}
        <p>
          roles {count(roles, agentLibrarySummary?.roleCount)} · profiles {count(profiles, agentLibrarySummary?.agentProfileCount)}
          {" "}· skills {count(skills, agentLibrarySummary?.skillCount)} · mcp {count(mcpServers, agentLibrarySummary?.mcpServerCount)}
          {" "}· tools {count(tools, agentLibrarySummary?.toolCount)}
        </p>
      </section>
      <section>
        <h3>Agent Team</h3>
        <p>{nodes.map((node) => node.label ?? node.id).join(" · ") || "No workflow nodes in read model."}</p>
      </section>
      <section>
        <h3>Roles</h3>
        {roles.length === 0 ? <p>No roles available.</p> : (
          <ul>
            {roles.map((role) => (
              <li key={rowId(role)}>
                <strong>{rowId(role)}</strong>
                {stringValue(role.responsibility) ? <span> · {stringValue(role.responsibility)}</span> : null}
                {stringValue(role.defaultAgentProfileRef) ? <span> · default {stringValue(role.defaultAgentProfileRef)}</span> : null}
                <span> · outputs {csv(role.artifactOutputs)}</span>
                <span> · stop {stringValue(role.stopAuthority) ?? "none"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Profiles</h3>
        {profiles.length === 0 ? <p>No profiles available.</p> : (
          <ul>
            {profiles.map((profile) => {
              const toolPolicy = asRecord(profile.toolPolicy);
              return (
                <li key={rowId(profile)}>
                  <strong>{rowId(profile)}</strong>
                  {stringValue(profile.name) ? <span> · {stringValue(profile.name)}</span> : null}
                  <span> · {stringValue(profile.provider) ?? "provider:auto"}</span>
                  {stringValue(profile.model) ? <span> · {stringValue(profile.model)}</span> : null}
                  {stringValue(profile.harnessRef) ? <span> · harness {stringValue(profile.harnessRef)}</span> : null}
                  <span> · skills {csv(profile.skillRefs)}</span>
                  <span> · mcp {csv(profile.mcpGrantRefs)}</span>
                  <span> · tools {csv(toolPolicy?.allowedTools)}</span>
                  <span> · context {stringValue(profile.contextPolicyRef) ?? "none"}</span>
                  <span> · session {stringValue(profile.sessionPolicyRef) ?? "none"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <h3>Skills</h3>
        {catalogList(skills, "No skills available.")}
      </section>
      <section>
        <h3>MCP Grants</h3>
        {catalogList(mcpServers, "No MCP grants available.")}
      </section>
      <section>
        <h3>Tools</h3>
        {catalogList(tools, "No tools available.")}
      </section>
      <section>
        <h3>Artifact Contracts</h3>
        {artifactContracts.length === 0 ? <p>No artifact contracts available.</p> : (
          <ul>
            {artifactContracts.map((contract) => (
              <li key={rowId(contract)}>
                <strong>{rowId(contract)}</strong>
                {stringValue(contract.artifactType) ? <span> · {stringValue(contract.artifactType)}</span> : null}
                <span> · required {csv(contract.requiredFields)}</span>
                <span> · evidence {csv(contract.evidenceFields)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Evaluator Pipelines</h3>
        {evaluatorPipelines.length === 0 ? <p>No evaluator pipelines available.</p> : (
          <ul>
            {evaluatorPipelines.map((pipeline) => {
              const failure = asRecord(pipeline.onFailure);
              return (
                <li key={rowId(pipeline)}>
                  <strong>{rowId(pipeline)}</strong>
                  <span> · evaluators {evaluatorSummary(pipeline.evaluators)}</span>
                  <span> · on failure {stringValue(failure?.defaultStrategy) ?? "none"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <h3>Policy</h3>
        <p>{policyRoleRef ?? "role:auto"} · {policyProfileRef ?? "profile:auto"}</p>
        <p>skillRefs: {selectedSkillRefs.join(", ") || "none"}</p>
        <p>mcpGrantRefs: {selectedMcpGrantRefs.join(", ") || "none"}</p>
        <p>toolGrantRefs: {selectedToolGrantRefs.join(", ") || "none"}</p>
      </section>
      <section>
        <h3>Context Policies</h3>
        {contextPolicies.length === 0 ? <p>No context policies available.</p> : (
          <ul>
            {contextPolicies.map((policy) => (
              <li key={rowId(policy)}>
                <strong>{rowId(policy)}</strong>
                <span> · max input {numberValue(policy.maxInputTokens)}</span>
                <span> · memory {stringValue(policy.memoryPolicyRef) ?? "none"}</span>
                <span> · agents.md {booleanLabel(policy.includeAgentsMd)}</span>
                <span> · workspace summary {booleanLabel(policy.includeWorkspaceSummary)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Memory Policies</h3>
        {memoryPolicies.length === 0 ? <p>No memory policies available.</p> : (
          <ul>
            {memoryPolicies.map((policy) => (
              <li key={rowId(policy)}>
                <strong>{rowId(policy)}</strong>
                <span> · provider {stringValue(policy.providerRef) ?? "none"}</span>
                <span> · scopes {csv(policy.scopes)}</span>
                <span> · candidates {numberValue(policy.maxCandidates)}</span>
                <span> · write approval {booleanLabel(policy.requireWriteApproval)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Session Policies</h3>
        {sessionPolicies.length === 0 ? <p>No session policies available.</p> : (
          <ul>
            {sessionPolicies.map((policy) => (
              <li key={rowId(policy)}>
                <strong>{rowId(policy)}</strong>
                <span> · checkpoints {csv(policy.checkpointOn)}</span>
                <span> · fork {booleanLabel(policy.allowFork)}</span>
                <span> · reset {booleanLabel(policy.allowReset)}</span>
                <span> · rollback {booleanLabel(policy.allowRollback)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Workspace Policies</h3>
        {workspacePolicies.length === 0 ? <p>No workspace policies available.</p> : (
          <ul>
            {workspacePolicies.map((policy) => (
              <li key={rowId(policy)}>
                <strong>{rowId(policy)}</strong>
                <span> · provider {stringValue(policy.provider) ?? "none"}</span>
                <span> · task snapshot {booleanLabel(policy.snapshotAtTaskStart)}</span>
                <span> · accepted snapshot {booleanLabel(policy.snapshotAtAcceptedArtifact)}</span>
                <span> · checker fork {booleanLabel(policy.forkOnCheckerReject)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {vaultPolicies.length > 0 ? (
        <section>
          <h3>Vault Policies</h3>
          <ul>
            {vaultPolicies.map((policy) => (
              <li key={rowId(policy)}>
                <strong>{rowId(policy)}</strong>
                {stringValue(policy.displayName) ? <span> · {stringValue(policy.displayName)}</span> : null}
                {stringValue(policy.secretGroupRef) ? <span> · secret group {stringValue(policy.secretGroupRef)}</span> : null}
                <span> · ttl {numberValue(policy.leaseTtlSeconds)}s</span>
                {stringValue(policy.mountMode) ? <span> · mount {stringValue(policy.mountMode)}</span> : null}
                <span> · tools {csv(policy.allowedToolRefs)}</span>
                <span> · audit {booleanLabel(policy.auditRequired)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>Context memory</h3>
        {contextMemoryRefs.length === 0 ? <p>No context memory refs in read model.</p> : <p>{contextMemoryRefs.join(", ")}</p>}
      </section>
      <section>
        <h3>Candidate reasons</h3>
        {selectionReasons.length === 0 ? <p>No candidate reasons in read model.</p> : <p>{selectionReasons.join(" · ")}</p>}
      </section>
      <section>
        <h3>Workspace</h3>
        <p className="ss-empty">{props.activeCwd ?? "No workspace selected"}</p>
      </section>
      <button type="button" onClick={props.onOpenAlternatives} disabled={props.alternativesDisabled}>
        View alternatives
      </button>
    </aside>
  );
}

function readAgentLibrary(model: any | null): RecordRow | null {
  const nested = asRecord(model?.agentLibrary ?? model?.library);
  if (nested) return nested;
  const direct = asRecord(model);
  return Array.isArray(direct?.roles) && Array.isArray(direct?.agentProfiles) ? direct : null;
}

function catalogList(rows: RecordRow[], emptyText: string) {
  if (rows.length === 0) return <p>{emptyText}</p>;
  return (
    <ul>
      {rows.map((row) => (
        <li key={rowId(row)}>
          <strong>{rowId(row)}</strong>
          {stringArray(row.profileRefs).length > 0 ? <span> · profiles {csv(row.profileRefs)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function evaluatorSummary(value: unknown): string {
  const evaluators = recordArray(value);
  if (evaluators.length === 0) return "none";
  return evaluators
    .map((evaluator) => {
      const id = rowId(evaluator);
      const kind = stringValue(evaluator.kind);
      const required = evaluator.required === true ? "required" : "optional";
      return kind ? `${id}:${kind}:${required}` : `${id}:${required}`;
    })
    .join(", ");
}

function csv(value: unknown): string {
  const items = stringArray(value);
  return items.length > 0 ? items.join(", ") : "none";
}

function count(rows: unknown[], fallback: unknown): number {
  return rows.length > 0 ? rows.length : numberValue(fallback);
}

function rowId(row: RecordRow): string {
  return stringValue(row.id ?? row.ref) ?? "unknown";
}

function recordArray(value: unknown): RecordRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RecordRow => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function booleanLabel(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function asRecord(value: unknown): RecordRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as RecordRow;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
