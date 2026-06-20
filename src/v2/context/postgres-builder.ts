import type { SouthstarDb as PostgresSouthstarDb } from "../db/postgres.ts";
import type { ArtifactContract, DomainPack } from "../domain-packs/types.ts";
import { persistKnowledgeCardInjectionTrace, selectKnowledgeCardsForTask } from "../evolution/context-cards.ts";
import { buildManagedContextSourceRefs } from "./event-slicing.ts";
import type { ContextBlock, ContextPacket, TokenEstimate } from "./types.ts";

export type BuildContextPacketWithKnowledgeCardsInput = {
  contextPacketId?: string;
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
  checkpointRef?: string;
  checkpointSummary?: string;
  workspaceSummary?: string;
  failureSummary?: string;
  contextSourceSummary?: string;
  intent: string;
  flowTemplateRef: string;
  promptTemplateRef?: string;
  skillRefs?: string[];
  maxKnowledgeCards?: number;
};

export async function buildContextPacketWithKnowledgeCards(
  db: PostgresSouthstarDb,
  input: BuildContextPacketWithKnowledgeCardsInput,
): Promise<ContextPacket> {
  const executionAttempt = input.executionAttempt ?? 1;
  const role = required(input.domainPack.roles.find((candidate) => candidate.id === input.roleRef), `role ${input.roleRef}`);
  const profile = required(
    input.domainPack.agentProfiles.find((candidate) => candidate.id === input.agentProfileRef),
    `agent profile ${input.agentProfileRef}`,
  );
  const contextPolicy = input.domainPack.contextPolicies.find((candidate) => candidate.id === profile.contextPolicyRef)
    ?? input.domainPack.contextPolicies[0];

  const artifactContracts = input.artifactContractRefs.map((artifactRef) =>
    artifactContractBlock(required(
      input.domainPack.artifactContracts.find((candidate) => candidate.id === artifactRef),
      `artifact contract ${artifactRef}`,
    ))
  );
  const artifactTypes = input.artifactContractRefs.map((artifactRef) =>
    required(input.domainPack.artifactContracts.find((candidate) => candidate.id === artifactRef), `artifact contract ${artifactRef}`).artifactType
  );
  const skillRefs = input.skillRefs ?? profile.skillRefs;
  const selected = await selectKnowledgeCardsForTask(db, {
    scope: input.domainPack.id,
    intent: input.intent,
    roleRef: role.id,
    artifactTypes,
    agentProfileRef: profile.id,
    promptTemplateRef: input.promptTemplateRef ?? profile.promptTemplateRef,
    skillRefs,
    flowTemplateRef: input.flowTemplateRef,
    maxCards: input.maxKnowledgeCards ?? 5,
  });

  const skillInstructions = profile.skillRefs.map((skillRef) => block("skill", skillRef, `Use skill snapshot ${skillRef}.`, skillRef));
  const mcpGrantSummary = profile.mcpGrantRefs.map((grantRef) => block("mcp", grantRef, `Allowed MCP grant ${grantRef}.`, grantRef));
  const agentsMdBlocks = contextPolicy?.includeAgentsMd === false
    ? []
    : profile.agentsMdRefs.map((ref) => block("agents-md", ref, `Reference ${ref}.`, ref));
  const priorArtifacts = input.priorArtifactRefs.map((ref) => block("artifact", ref, `Prior artifact ${ref}.`, ref));
  const checkpointSummary = input.checkpointSummary ? block("checkpoint", "Checkpoint", input.checkpointSummary, input.checkpointRef) : undefined;
  const workspaceSummary = input.workspaceSummary && contextPolicy?.includeWorkspaceSummary !== false
    ? block("workspace", "Workspace", input.workspaceSummary)
    : undefined;
  const failureSummary = input.failureSummary ? block("failure", "Failure", input.failureSummary) : undefined;
  const contextSourceSummary = input.contextSourceSummary ? block("workspace", "Context Sources", input.contextSourceSummary) : undefined;

  const tokenEstimate = estimatePacketTokens([
    block("prompt", "Goal", input.goalPrompt, input.runId),
    block("role", role.id, role.responsibility, role.id),
    ...agentsMdBlocks,
    ...artifactContracts,
    ...selected.selectedCards,
    ...priorArtifacts,
    ...skillInstructions,
    ...mcpGrantSummary,
    ...definedBlocks([checkpointSummary, workspaceSummary, failureSummary, contextSourceSummary]),
  ]);
  if (contextPolicy && tokenEstimate.total > contextPolicy.maxInputTokens) {
    throw new Error(`context packet exceeds maxInputTokens: ${tokenEstimate.total} > ${contextPolicy.maxInputTokens}`);
  }

  const packet: ContextPacket = {
    id: input.contextPacketId ?? `ctx-${input.runId}-${input.taskId}-attempt-${executionAttempt}`,
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
    selectedMemories: [],
    selectedKnowledgeCards: selected.selectedCards,
    priorArtifacts: contextSourceSummary ? [...priorArtifacts, contextSourceSummary] : priorArtifacts,
    checkpointSummary,
    workspaceSummary,
    failureSummary,
    skillInstructions,
    mcpGrantSummary,
    forbiddenActions: profile.toolPolicy.deniedTools,
    budget: profile.budgetPolicy,
    tokenEstimate,
    excludedCandidates: [],
  };
  const managedSourceRefs = buildManagedContextSourceRefs({
    rawEventRefs: [],
    omittedEventRanges: [],
    transformRefs: [],
    checkpointRefs: [checkpointSummary?.sourceRef ?? checkpointSummary?.id].filter((item): item is string => Boolean(item)),
  });
  packet.managedSourceRefs = managedSourceRefs;

  const refs = await postgresResourcePersistenceRefs(db, input.runId, input.taskId);
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'context_packet', $1, $2, $3, $4, $5, 'created', $6, $7::jsonb, $8::jsonb, '{}'::jsonb, now(), now())
    on conflict(resource_type, resource_key) do update set
      run_id = excluded.run_id,
      task_id = excluded.task_id,
      session_id = excluded.session_id,
      scope = excluded.scope,
      status = excluded.status,
      title = excluded.title,
      payload_json = excluded.payload_json,
      summary_json = excluded.summary_json,
      updated_at = now()`,
    [
      packet.id,
      refs.runId ?? null,
      refs.taskId ?? null,
      input.rootSessionId ?? null,
      input.domainPack.id,
      `Context for ${input.taskId}`,
      JSON.stringify(packet),
      JSON.stringify({ tokenEstimate: tokenEstimate.total, selectedKnowledgeCards: selected.selectedCardRefs.length }),
    ],
  );
  await persistKnowledgeCardInjectionTrace(db, {
    contextPacketId: packet.id,
    runId: refs.runId,
    taskId: refs.taskId,
    sessionId: input.rootSessionId,
    scope: input.domainPack.id,
    matchedTaskMetadata: selected.matchedTaskMetadata,
    selectedCards: selected.selectedCards,
    selectedCardRefs: selected.selectedCardRefs,
    excludedCards: selected.excludedCards,
    tokenEstimate: selected.tokenEstimate,
  });
  return packet;
}

async function postgresResourcePersistenceRefs(db: PostgresSouthstarDb, runId: string, taskId: string): Promise<{ runId?: string; taskId?: string }> {
  const runExists = Boolean(await db.maybeOne("select 1 from southstar.workflow_runs where id = $1", [runId]));
  if (!runExists) return {};
  const taskExists = Boolean(await db.maybeOne("select 1 from southstar.workflow_tasks where run_id = $1 and id = $2", [runId, taskId]));
  return { runId, taskId: taskExists ? taskId : undefined };
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
  for (const item of blocks) bySourceType[item.sourceType] = (bySourceType[item.sourceType] ?? 0) + item.tokenEstimate;
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
