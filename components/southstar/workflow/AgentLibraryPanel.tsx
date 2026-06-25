type WorkflowNodeLike = {
  id: string;
  label?: string;
  roleRef?: string | null;
  agentProfileRef?: string | null;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
  toolGrantRefs?: string[];
};

export function AgentLibraryPanel(props: {
  model: any | null;
  activeCwd: string | null;
  selectedTaskId: string | null;
  onOpenAlternatives: () => void;
  alternativesDisabled: boolean;
}) {
  const agentLibrarySummary = asRecord(props.model?.agentLibrarySummary);
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

  return (
    <aside className="ss-library-context">
      <h2>Agent Library</h2>
      <section>
        <h3>Domain Pack</h3>
        <p>{stringValue(agentLibrarySummary?.domain) ?? "unknown"}</p>
        <p>
          roles {numberValue(agentLibrarySummary?.roleCount)} · profiles {numberValue(agentLibrarySummary?.agentProfileCount)}
          {" "}· skills {numberValue(agentLibrarySummary?.skillCount)} · mcp {numberValue(agentLibrarySummary?.mcpServerCount)}
        </p>
      </section>
      <section>
        <h3>Agent Team</h3>
        <p>{nodes.map((node) => node.label ?? node.id).join(" · ") || "No workflow nodes in read model."}</p>
      </section>
      <section>
        <h3>Policy</h3>
        <p>{policyRoleRef ?? "role:auto"} · {policyProfileRef ?? "profile:auto"}</p>
        <p>skillRefs: {selectedSkillRefs.join(", ") || "none"}</p>
        <p>mcpGrantRefs: {selectedMcpGrantRefs.join(", ") || "none"}</p>
        <p>toolGrantRefs: {selectedToolGrantRefs.join(", ") || "none"}</p>
      </section>
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
