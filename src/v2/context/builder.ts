import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { ArtifactContract, DomainPack, RoleDefinition } from "../domain-packs/types.ts";
import { createSqliteMemoryProvider } from "../memory/sqlite-provider.ts";
import type { MemoryCandidate } from "../memory/provider.ts";
import type { ContextBlock, ContextExclusion, ContextPacket, TokenEstimate } from "./types.ts";

export type BuildContextPacketInput = {
  runId: string;
  taskId: string;
  rootSessionId?: string;
  executionAttempt?: number;
  goalPrompt: string;
  domainPack: DomainPack;
  roleRef: string;
  agentProfileRef: string;
  artifactContractRefs: string[];
  priorArtifactRefs: string[];
  checkpointSummary?: string;
  workspaceSummary?: string;
  failureSummary?: string;
};

export function buildContextPacket(db: SouthstarDb, input: BuildContextPacketInput): ContextPacket {
  const executionAttempt = input.executionAttempt ?? 1;
  const role = required(input.domainPack.roles.find((candidate) => candidate.id === input.roleRef), `role ${input.roleRef}`);
  const profile = required(
    input.domainPack.agentProfiles.find((candidate) => candidate.id === input.agentProfileRef),
    `agent profile ${input.agentProfileRef}`,
  );
  const contextPolicy = input.domainPack.contextPolicies.find((candidate) => candidate.id === profile.contextPolicyRef)
    ?? input.domainPack.contextPolicies[0];
  const memoryPolicy = input.domainPack.memoryPolicies.find((candidate) => candidate.id === contextPolicy?.memoryPolicyRef)
    ?? input.domainPack.memoryPolicies.find((candidate) => candidate.id === "software-memory-default")
    ?? input.domainPack.memoryPolicies[0];
  if (!memoryPolicy) throw new Error("missing memory policy");

  const memoryProvider = createSqliteMemoryProvider(db);
  const candidates = memoryProvider.search({
    query: `${input.goalPrompt} ${role.responsibility}`,
    scopes: memoryPolicy.scopes.length > 0 ? memoryPolicy.scopes : profile.memoryScopes,
    maxCandidates: memoryPolicy.maxCandidates,
  });
  const { selectedMemories, excludedCandidates, includedTrace, excludedTrace, memoryTokenEstimate } = selectMemoryCandidates(
    candidates,
    memoryPolicy.maxInjectedTokens,
    new Set(memoryPolicy.allowedKinds),
  );

  const artifactContracts = input.artifactContractRefs.map((artifactRef) =>
    artifactContractBlock(required(
      input.domainPack.artifactContracts.find((candidate) => candidate.id === artifactRef),
      `artifact contract ${artifactRef}`,
    ))
  );
  const skillInstructions = profile.skillRefs.map((skillRef) =>
    block("skill", skillRef, `Use skill snapshot ${skillRef}.`, skillRef)
  );
  const mcpGrantSummary = profile.mcpGrantRefs.map((grantRef) =>
    block("mcp", grantRef, `Allowed MCP grant ${grantRef}.`, grantRef)
  );
  const agentsMdBlocks = contextPolicy?.includeAgentsMd === false
    ? []
    : profile.agentsMdRefs.map((ref) => block("agents-md", ref, `Reference ${ref}.`, ref));
  const priorArtifacts = input.priorArtifactRefs.map((ref) => block("artifact", ref, `Prior artifact ${ref}.`, ref));
  const checkpointSummary = input.checkpointSummary
    ? block("checkpoint", "Checkpoint", input.checkpointSummary)
    : undefined;
  const workspaceSummary = input.workspaceSummary && contextPolicy?.includeWorkspaceSummary !== false
    ? block("workspace", "Workspace", input.workspaceSummary)
    : undefined;
  const failureSummary = input.failureSummary ? block("failure", "Failure", input.failureSummary) : undefined;

  const tokenEstimate = estimatePacketTokens([
    block("prompt", "Goal", input.goalPrompt, input.runId),
    block("role", role.id, role.responsibility, role.id),
    ...agentsMdBlocks,
    ...artifactContracts,
    ...selectedMemories,
    ...priorArtifacts,
    ...skillInstructions,
    ...mcpGrantSummary,
    ...definedBlocks([checkpointSummary, workspaceSummary, failureSummary]),
  ]);
  if (contextPolicy && tokenEstimate.total > contextPolicy.maxInputTokens) {
    throw new Error(`context packet exceeds maxInputTokens: ${tokenEstimate.total} > ${contextPolicy.maxInputTokens}`);
  }
  const packet: ContextPacket = {
    id: `ctx-${input.runId}-${input.taskId}-attempt-${executionAttempt}`,
    runId: input.runId,
    taskId: input.taskId,
    rootSessionId: input.rootSessionId,
    executionAttempt,
    roleRef: role.id,
    agentProfileRef: profile.id,
    taskGoal: input.goalPrompt,
    roleInstruction: role.responsibility,
    systemInstruction: profile.systemPromptRef,
    agentsMdBlocks,
    artifactContracts,
    selectedMemories,
    priorArtifacts,
    checkpointSummary,
    workspaceSummary,
    failureSummary,
    skillInstructions,
    mcpGrantSummary,
    forbiddenActions: profile.toolPolicy.deniedTools,
    budget: profile.budgetPolicy,
    tokenEstimate,
    excludedCandidates,
  };
  const persistenceRefs = resourcePersistenceRefs(db, input.runId, input.taskId);

  upsertRuntimeResource(db, {
    id: packet.id,
    resourceType: "context_packet",
    resourceKey: packet.id,
    runId: persistenceRefs.runId,
    taskId: persistenceRefs.taskId,
    sessionId: input.rootSessionId,
    scope: input.domainPack.id,
    status: "created",
    title: `Context for ${input.taskId}`,
    payload: packet,
    summary: { tokenEstimate: tokenEstimate.total, selectedMemories: selectedMemories.length },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_injection_trace",
    resourceKey: `mem-trace-${packet.id}`,
    runId: persistenceRefs.runId,
    taskId: persistenceRefs.taskId,
    sessionId: input.rootSessionId,
    scope: input.domainPack.id,
    status: "created",
    title: `Memory injection for ${input.taskId}`,
    payload: {
      contextPacketId: packet.id,
      included: includedTrace,
      excluded: excludedTrace,
      decisionReason: memoryDecisionReason(candidates.length, includedTrace.length, excludedTrace.length),
      tokenEstimate: memoryTokenEstimate,
    },
  });
  return packet;
}

function memoryDecisionReason(candidateCount: number, includedCount: number, excludedCount: number): string {
  if (candidateCount === 0) return "No approved memory candidates matched the query and memory scopes; zero memories injected.";
  if (includedCount === 0) return "All approved memory candidates were excluded; see excluded trace reasons.";
  return `${includedCount} approved memory candidate(s) injected; see included trace reasons.`;
}

function selectMemoryCandidates(
  candidates: MemoryCandidate[],
  maxInjectedTokens: number,
  allowedKinds: Set<string>,
): {
  selectedMemories: ContextBlock[];
  excludedCandidates: ContextExclusion[];
  includedTrace: Array<ContextBlock & { reason: string; score: number }>;
  excludedTrace: Array<ContextExclusion & { text: string; score: number }>;
  memoryTokenEstimate: number;
} {
  const selectedMemories: ContextBlock[] = [];
  const excludedCandidates: ContextExclusion[] = [];
  const includedTrace: Array<ContextBlock & { reason: string; score: number }> = [];
  const excludedTrace: Array<ContextExclusion & { text: string; score: number }> = [];
  const seen = new Set<string>();
  let memoryTokens = 0;

  for (const candidate of candidates) {
    const sourceRef = candidate.sourceRef ?? candidate.id;
    const duplicate = seen.has(sourceRef);
    seen.add(sourceRef);
    const exclusion = memoryExclusion(candidate, {
      duplicate,
      allowedKinds,
      currentTokens: memoryTokens,
      maxInjectedTokens,
    });
    if (exclusion) {
      excludedCandidates.push(exclusion);
      excludedTrace.push({ ...exclusion, text: candidate.text, score: candidate.score });
      continue;
    }
    const memoryBlock = block("memory", candidate.kind, candidate.text, sourceRef, candidate.tokenEstimate);
    selectedMemories.push(memoryBlock);
    includedTrace.push({ ...memoryBlock, reason: "selected: approved memory matched scope, kind, and budget", score: candidate.score });
    memoryTokens += candidate.tokenEstimate;
  }

  return {
    selectedMemories,
    excludedCandidates,
    includedTrace,
    excludedTrace,
    memoryTokenEstimate: Math.max(1, memoryTokens + excludedCandidates.reduce((sum, next) => sum + next.tokenEstimate, 0)),
  };
}

function memoryExclusion(
  candidate: MemoryCandidate,
  input: { duplicate: boolean; allowedKinds: Set<string>; currentTokens: number; maxInjectedTokens: number },
): ContextExclusion | undefined {
  const sourceRef = candidate.sourceRef ?? candidate.id;
  if (input.duplicate) return { sourceRef, reason: "duplicate", tokenEstimate: candidate.tokenEstimate };
  if (input.allowedKinds.size > 0 && !input.allowedKinds.has(candidate.kind)) {
    return { sourceRef, reason: "kind-mismatch", tokenEstimate: candidate.tokenEstimate };
  }
  if (candidate.score <= 0) return { sourceRef, reason: "low-score", tokenEstimate: candidate.tokenEstimate };
  if (input.currentTokens + candidate.tokenEstimate > input.maxInjectedTokens) {
    return { sourceRef, reason: "over-budget", tokenEstimate: candidate.tokenEstimate };
  }
  return undefined;
}

function artifactContractBlock(contract: ArtifactContract): ContextBlock {
  return block(
    "artifact",
    contract.id,
    [
      `Artifact type: ${contract.artifactType}.`,
      `Required fields: ${contract.requiredFields.join(", ")}.`,
      `Evidence fields: ${contract.evidenceFields.join(", ")}.`,
    ].join(" "),
    contract.id,
  );
}

function block(
  sourceType: ContextBlock["sourceType"],
  title: string,
  text: string,
  sourceRef?: string,
  tokenEstimate = estimateTokens(text),
): ContextBlock {
  return {
    id: `${sourceType}-${title}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
    sourceType,
    title,
    text,
    sourceRef,
    tokenEstimate,
  };
}

function estimatePacketTokens(blocks: ContextBlock[]): TokenEstimate {
  const bySourceType: Record<string, number> = {};
  for (const item of blocks) {
    bySourceType[item.sourceType] = (bySourceType[item.sourceType] ?? 0) + item.tokenEstimate;
  }
  return { total: Object.values(bySourceType).reduce((sum, next) => sum + next, 0), bySourceType };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function definedBlocks(blocks: Array<ContextBlock | undefined>): ContextBlock[] {
  return blocks.filter((item): item is ContextBlock => Boolean(item));
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function resourcePersistenceRefs(db: SouthstarDb, runId: string, taskId: string): { runId?: string; taskId?: string } {
  const runExists = Boolean(db.prepare("select 1 from workflow_runs where id = ?").get(runId));
  if (!runExists) return {};
  const taskExists = Boolean(db.prepare("select 1 from workflow_tasks where run_id = ? and id = ?").get(runId, taskId));
  return { runId, taskId: taskExists ? taskId : undefined };
}

export type DomainPackContextMetadata = Pick<
  DomainPack,
  "id" | "roles" | "agentProfiles" | "artifactContracts" | "contextPolicies" | "memoryPolicies"
>;

export function resolveRoleProfile(input: {
  taskId: string;
  roleRef?: string;
  agentProfileRef?: string;
  roles: RoleDefinition[];
}): { roleRef: string; agentProfileRef: string } {
  const roleRef = input.roleRef ?? legacyRoleRef(input.taskId);
  const role = input.roles.find((candidate) => candidate.id === roleRef)
    ?? input.roles.find((candidate) => candidate.id === "maker")
    ?? input.roles[0];
  if (!role) throw new Error("missing role metadata");
  return {
    roleRef: role.id,
    agentProfileRef: input.agentProfileRef ?? role.defaultAgentProfileRef,
  };
}

export function resolveArtifactContractRefs(input: {
  requiredArtifactRefs?: string[];
  subagentArtifactTypes: string[];
  artifactContracts: ArtifactContract[];
}): string[] {
  if (input.requiredArtifactRefs && input.requiredArtifactRefs.length > 0) return input.requiredArtifactRefs;
  return input.subagentArtifactTypes
    .map((artifactType) => input.artifactContracts.find((contract) => contract.artifactType === artifactType)?.id)
    .filter((id): id is string => Boolean(id));
}

function legacyRoleRef(taskId: string): string {
  if (/summar/i.test(taskId)) return "summarizer";
  if (/verify|check/i.test(taskId)) return "checker";
  if (/implement|make|build/i.test(taskId)) return "maker";
  return "explorer";
}
