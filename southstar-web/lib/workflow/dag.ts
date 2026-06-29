import type { WorkflowAgentSummary, WorkflowDag, WorkflowTemplateSummary } from "./types";

export function buildWorkflowDagProposal(input: {
  prompt: string;
  template: WorkflowTemplateSummary;
  agents: WorkflowAgentSummary[];
}): WorkflowDag {
  const selectedAgents = input.template.agentRefs
    .map((agentRef) => input.agents.find((agent) => agent.id === agentRef))
    .filter((agent): agent is WorkflowAgentSummary => Boolean(agent));
  const fallbackAgents = selectedAgents.length > 0 ? selectedAgents : input.agents;

  const stageIds = input.template.stageRefs.length > 0
    ? input.template.stageRefs
    : ["understand", "plan", "implement", "verify", "summarize"];
  const nodes = stageIds.map((stageId, index) => {
    const agent = fallbackAgents[index] ?? fallbackAgents[fallbackAgents.length - 1];
    const defaultProfileRef = agent?.defaultProfileRef ?? "profile.software-maker-pi";
    const provider = defaultProfileRef.endsWith("-pi") ? "pi" : "codex";
    return {
      id: stageId,
      label: labelFromStage(stageId),
      role: agent?.role ?? "maker",
      agentRef: agent?.id ?? "agent.software-maker",
      profileRef: defaultProfileRef,
      profileResourcePath: agent?.profileResourcePath ?? "software/agents/maker/profile.json",
      provider,
      model: provider === "pi" ? "pi-agent-default" : "gpt-5-codex",
      level: levelFromStage(stageId, index),
      state: "ready" as const,
    };
  });

  return {
    id: `dag-${Date.now()}`,
    templateId: input.template.id,
    templateTitle: input.template.title,
    prompt: input.prompt,
    expandedByDefault: true,
    readiness: "ready",
    nodes,
    edges: buildEdges(stageIds),
    createdAt: new Date().toISOString(),
  };
}

function labelFromStage(stageId: string): string {
  return stageId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function levelFromStage(stageId: string, index: number): number {
  if (stageId.startsWith("implement")) return 2;
  if (stageId.includes("verify") || stageId.includes("check")) return 3;
  if (stageId.includes("summar")) return 4;
  return index;
}

function buildEdges(stageIds: string[]) {
  if (stageIds.length < 2) return [];
  return stageIds.slice(1).map((stageId, index) => ({
    from: stageIds[index]!,
    to: stageId,
  }));
}
