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
  const agentByRole = new Map(fallbackAgents.map((agent) => [agent.role, agent]));

  const baseStageIds = input.template.stageRefs.length > 0
    ? input.template.stageRefs
    : ["understand", "plan", "implement", "verify", "summarize"];
  const stageIds = expandStageIdsForPrompt(baseStageIds, input.prompt);
  const nodes = stageIds.map((stageId, index) => {
    const agent = agentForStage(stageId, agentByRole) ?? fallbackAgents[index] ?? fallbackAgents[fallbackAgents.length - 1];
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
    edges: buildEdges(nodes),
    createdAt: new Date().toISOString(),
  };
}

function expandStageIdsForPrompt(stageIds: string[], prompt: string): string[] {
  if (!shouldGenerateParallelDag(prompt) || !stageIds.includes("implement")) return stageIds;
  return stageIds.flatMap((stageId) => (
    stageId === "implement" ? ["implement-ui", "implement-api"] : [stageId]
  ));
}

function shouldGenerateParallelDag(prompt: string): boolean {
  return /並行|平行|parallel|concurrent|frontend|backend|front-end|back-end|api|ui/i.test(prompt);
}

function agentForStage(stageId: string, agentByRole: Map<string, WorkflowAgentSummary>): WorkflowAgentSummary | undefined {
  if (stageId === "understand") return agentByRole.get("explorer");
  if (stageId === "plan") return agentByRole.get("planner");
  if (stageId.startsWith("implement")) return agentByRole.get("maker");
  if (stageId.includes("verify") || stageId.includes("check")) return agentByRole.get("checker");
  if (stageId.includes("summar")) return agentByRole.get("summarizer");
  return undefined;
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

function buildEdges(nodes: WorkflowDag["nodes"]) {
  const levels = Array.from(new Set(nodes.map((node) => node.level))).sort((a, b) => a - b);
  if (levels.length < 2) return [];

  const nodesByLevel = new Map<number, WorkflowDag["nodes"]>();
  for (const level of levels) {
    nodesByLevel.set(level, nodes.filter((node) => node.level === level));
  }

  const edges = [];
  for (let index = 0; index < levels.length - 1; index += 1) {
    const fromNodes = nodesByLevel.get(levels[index]!) ?? [];
    const toNodes = nodesByLevel.get(levels[index + 1]!) ?? [];
    for (const fromNode of fromNodes) {
      for (const toNode of toNodes) {
        edges.push({ from: fromNode.id, to: toNode.id });
      }
    }
  }
  return edges;
}
