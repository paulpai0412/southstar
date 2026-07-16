import type { ReadModelKind } from "../read-models/types.ts";
import type { ApiEnvelope } from "../server/types.ts";
import type { RuntimeCommandRequest } from "../ui-api/commands/runtime-command.ts";

type RuntimeLoopId =
  | "executor-reconciler"
  | "runnable-task-scheduler"
  | "recovery-controller"
  | "tork-exception-observer"
  | "recovery-decision-applier";

export type SouthstarMcpRuntimeClient = {
  getRuntimeHealth(): Promise<ApiEnvelope<unknown>>;
  getRuntimeLoops(): Promise<ApiEnvelope<unknown>>;
  tickRuntimeLoop(body: { loopId: RuntimeLoopId }): Promise<ApiEnvelope<unknown>>;
  wakeRuntime(body?: { runId?: string; taskId?: string }): Promise<ApiEnvelope<unknown>>;

  runGoalStream(body: {
    goalPrompt: string;
    cwd: string;
    projectRef?: string;
    idempotencyKey: string;
    goalDesignMode?: "review_before_compose" | "auto_until_blocked";
    templatePolicy?: { mode: "auto" | "prefer" | "require"; templateRef?: string; versionRef?: string };
  }, onEvent: (event: SouthstarMcpStreamEvent) => void, signal?: AbortSignal): Promise<unknown>;

  getLibraryWorkspace(body?: { scope?: string }): Promise<ApiEnvelope<unknown>>;
  getLibraryGraph(body?: { scope?: string; objectKey?: string; depth?: number; kind?: string; status?: string; edgeType?: string }): Promise<ApiEnvelope<unknown>>;
  createLibraryImportDraft(body: { source: unknown; scope?: string; requestPrompt?: string }): Promise<ApiEnvelope<unknown>>;
  getLibraryImportDraft(draftId: string): Promise<ApiEnvelope<unknown>>;
  installLibraryImportCandidates(body: { draftId: string; selectedCandidateIds: string[]; selectedEdgeIds?: string[]; actor?: string; reason: string }): Promise<ApiEnvelope<unknown>>;
  installLibraryImportCandidatesStream(body: { draftId: string; selectedCandidateIds: string[]; selectedEdgeIds?: string[]; actor?: string; reason: string }, onEvent: (event: SouthstarMcpStreamEvent) => void, signal?: AbortSignal): Promise<unknown>;
  getLibraryObject(objectKey: string): Promise<ApiEnvelope<unknown>>;
  setLibraryObjectLifecycle(body: { objectKey: string; action: "approve" | "deprecate" | "block"; actor?: string; reason: string }): Promise<ApiEnvelope<unknown>>;
  listLibraryFiles(): Promise<ApiEnvelope<unknown>>;
  getLibraryFile(relativePath: string): Promise<ApiEnvelope<unknown>>;
  updateLibraryFile(body: { relativePath: string; content: string }): Promise<ApiEnvelope<unknown>>;
  validateLibraryFile(relativePath: string): Promise<ApiEnvelope<unknown>>;
  syncLibraryFile(relativePath: string): Promise<ApiEnvelope<unknown>>;
  composeLibraryProfile(body: { scope?: string; nodeId: string; requirement: string; preferredAgentRef: string; templateId?: string }): Promise<ApiEnvelope<unknown>>;
  validateLibraryProfile(body: { profile?: unknown; draft?: unknown }): Promise<ApiEnvelope<unknown>>;
  saveLibraryProfile(body: { draft: unknown; templateId: string; actor?: string; reason: string }): Promise<ApiEnvelope<unknown>>;

  createPlannerDraft(body: { goalPrompt: string; orchestrationMode?: "llm-constrained"; composerMode?: "llm"; scope?: string }): Promise<ApiEnvelope<unknown>>;
  createPlannerDraftStream(body: { goalPrompt: string; orchestrationMode?: "llm-constrained"; composerMode?: "llm"; scope?: string; cwd?: string }, onEvent: (event: SouthstarMcpStreamEvent) => void, signal?: AbortSignal): Promise<unknown>;
  revisePlannerDraft(body: { draftId: string; prompt: string; orchestrationMode?: "llm-constrained"; composerMode?: "llm" }): Promise<ApiEnvelope<unknown>>;
  reviseGoalRequirement(body: { draftId: string; requirementId: string; expectedDraftHash: string; patch: unknown; actor?: string }): Promise<ApiEnvelope<unknown>>;
  confirmGoalRequirements(body: { draftId: string; expectedDraftHash: string; actor?: string }): Promise<ApiEnvelope<unknown>>;
  confirmGoalDesign(body: { draftId: string; expectedPackageHash: string }): Promise<ApiEnvelope<unknown>>;
  confirmGoalDesignStream(body: { draftId: string; expectedPackageHash: string }, onEvent: (event: SouthstarMcpStreamEvent) => void, signal?: AbortSignal): Promise<unknown>;
  revisePlannerDraftStream(body: { draftId: string; prompt: string; orchestrationMode?: "llm-constrained"; composerMode?: "llm" }, onEvent: (event: SouthstarMcpStreamEvent) => void, signal?: AbortSignal): Promise<unknown>;
  searchWorkflowTemplates(body: { prompt: string; domain?: string; limit?: number }): Promise<ApiEnvelope<unknown>>;
  getWorkflowTemplate(templateRef: string): Promise<ApiEnvelope<unknown>>;
  instantiateWorkflowTemplate(body: {
    templateRef: string;
    goalPrompt: string;
    cwd?: string;
    repo?: { path?: string; url?: string; branch?: string };
    constraints?: { mode?: "strict" | "adaptive"; maxNodes?: number; requireApproval?: boolean };
  }): Promise<ApiEnvelope<unknown>>;
  getPlannerDraftOrchestration(draftId: string): Promise<ApiEnvelope<unknown>>;
  listPlannerDraftProposals(draftId: string): Promise<ApiEnvelope<unknown>>;
  approvePlannerDraftProposal(body: { draftId: string; proposalId: string; actorId?: string; reason?: string }): Promise<ApiEnvelope<unknown>>;
  rejectPlannerDraftProposal(body: { draftId: string; proposalId: string; actorId?: string; reason?: string }): Promise<ApiEnvelope<unknown>>;
  convertPlannerDraftProposalToLibraryDraft(body: { draftId: string; proposalId: string; actorId?: string; reason?: string }): Promise<ApiEnvelope<unknown>>;
  saveWorkflowTemplate(body: { draftId: string; templateId: string; title: string; scope?: string; status?: "draft" | "approved" }): Promise<ApiEnvelope<unknown>>;
  createRunFromPlannerDraft(draftId: string): Promise<ApiEnvelope<unknown>>;

  getRun(runId: string): Promise<ApiEnvelope<unknown>>;
  getTask(body: { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  getReadModel(body: { kind: ReadModelKind; runId: string; taskId?: string }): Promise<ApiEnvelope<unknown>>;
  getTaskEnvelope(body: { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  getRunActions(runId: string): Promise<ApiEnvelope<unknown>>;
  pauseRun(body: RuntimeCommandRequest & { runId: string }): Promise<ApiEnvelope<unknown>>;
  resumeRun(body: RuntimeCommandRequest & { runId: string }): Promise<ApiEnvelope<unknown>>;
  cancelRun(body: RuntimeCommandRequest & { runId: string }): Promise<ApiEnvelope<unknown>>;
  getTaskActions(body: { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  retryTask(body: RuntimeCommandRequest & { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  forkTaskSession(body: RuntimeCommandRequest & { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  resetTaskSession(body: RuntimeCommandRequest & { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  rollbackTaskSession(body: RuntimeCommandRequest & { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  requestTaskRevision(body: RuntimeCommandRequest & { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  listArtifacts(runId: string): Promise<ApiEnvelope<unknown>>;
  getArtifact(body: { artifactRef: string }): Promise<ApiEnvelope<unknown>>;
  listSessions(runId: string): Promise<ApiEnvelope<unknown>>;
  getSessionEvents(body: { sessionId: string; afterSequence?: number; beforeSequence?: number; limit?: number; eventTypes?: string[]; taskId?: string; correlationId?: string; artifactRef?: string; aroundEventId?: string; windowBefore?: number; windowAfter?: number }): Promise<ApiEnvelope<unknown>>;
  getSessionCheckpoints(sessionId: string): Promise<ApiEnvelope<unknown>>;
  searchMemory(body: { runId: string; query: string; scopes: string[]; allowedKinds: string[]; maxCandidates?: number }): Promise<ApiEnvelope<unknown>>;
  listMemory(runId: string): Promise<ApiEnvelope<unknown>>;
  listMemoryDeltas(runId: string): Promise<ApiEnvelope<unknown>>;
  approveMemoryDelta(body: { deltaId: string; approvedBy: string; reason: string }): Promise<ApiEnvelope<unknown>>;
  rejectMemoryDelta(body: { deltaId: string; rejectedBy: string; reason: string }): Promise<ApiEnvelope<unknown>>;
  listExecutions(runId: string): Promise<ApiEnvelope<unknown>>;
  getExecution(body: { runId: string; executionId: string }): Promise<ApiEnvelope<unknown>>;
  reconcileExecutorJob(body: { runId: string; jobId: string }): Promise<ApiEnvelope<unknown>>;
  cancelExecutorJob(body: RuntimeCommandRequest & { runId: string; jobId: string }): Promise<ApiEnvelope<unknown>>;
  listLogs(runId: string): Promise<ApiEnvelope<unknown>>;
  listApprovals(runId: string): Promise<ApiEnvelope<unknown>>;
  decideApproval(body: { runId: string; approvalId: string; decision: "approved" | "rejected"; reason: string }): Promise<ApiEnvelope<unknown>>;
  approveRecoveryDecision(body: { runId: string; decisionId: string; decision: "approved" | "rejected"; reason: string }): Promise<ApiEnvelope<unknown>>;
  applyRecoveryDecision(body: { runId: string; decisionId: string }): Promise<ApiEnvelope<unknown>>;
  steerRun(body: { runId: string; message: string }): Promise<ApiEnvelope<unknown>>;
  streamRunEvents(body: { runId: string; after?: number; taskId?: string; includeRunEvents?: boolean; closeOnTerminal?: boolean; pollMs?: number; heartbeatMs?: number }, onEvent: (event: SouthstarMcpStreamEvent) => void, signal?: AbortSignal): Promise<unknown>;
};

export type SouthstarMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SouthstarMcpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
};

export type SouthstarMcpStreamEvent = {
  event: string;
  data: unknown;
  id?: string;
};

export type SouthstarMcpToolCallContext = {
  onEvent?: (event: SouthstarMcpStreamEvent) => void;
  signal?: AbortSignal;
};

export type SouthstarMcpToolRegistry = {
  listTools(): SouthstarMcpTool[];
  callTool(name: string, input: unknown, context?: SouthstarMcpToolCallContext): Promise<SouthstarMcpToolResult>;
};

type ToolDefinition = SouthstarMcpTool & { call: (value: unknown, context: SouthstarMcpToolCallContext) => Promise<unknown> };

export function createSouthstarMcpToolRegistry(input: { client: SouthstarMcpRuntimeClient }): SouthstarMcpToolRegistry {
  const c = input.client;
  const tools: ToolDefinition[] = [
    tool("southstar.system.status", "Read Southstar runtime health.", {}, [], async () => unwrap(await c.getRuntimeHealth())),
    tool("southstar.system.loops", "List configured runtime loops.", {}, [], async () => unwrap(await c.getRuntimeLoops())),
    tool("southstar.system.tick_loop", "Manually tick one runtime loop.", { loopId: stringSchema("Runtime loop id.") }, ["loopId"], async (value) => unwrap(await c.tickRuntimeLoop({ loopId: runtimeLoopId(asRecord(value).loopId) }))),
    tool("southstar.system.wake", "Wake runtime loops.", { runId: optionalStringSchema("Optional run id."), taskId: optionalStringSchema("Optional task id.") }, [], async (value) => unwrap(await c.wakeRuntime(optionalRunTask(asRecord(value))))),

    tool("southstar.library.get_workspace", "Read Library workspace state.", { scope: optionalStringSchema("Library scope.") }, [], async (value) => unwrap(await c.getLibraryWorkspace(optionalScope(asRecord(value))))),
    tool("southstar.library.get_graph", "Query the Library graph.", graphSchema(), [], async (value) => unwrap(await c.getLibraryGraph(graphQuery(asRecord(value))))),
    tool("southstar.library.import_from_source", "Create a Library import draft from a source.", { source: optionalObjectSchema("Import source."), scope: optionalStringSchema("Scope."), requestPrompt: optionalStringSchema("Prompt.") }, ["source"], async (value) => {
      const body = asRecord(value);
      return unwrap(await c.createLibraryImportDraft({ source: requiredValue(body.source, "source"), ...optionalScope(body), ...(optionalString(body.requestPrompt) ? { requestPrompt: optionalString(body.requestPrompt) } : {}) }));
    }),
    tool("southstar.library.get_import_draft", "Read reviewable candidates and proposed edges for a Library import draft.", { draftId: stringSchema("Import draft id.") }, ["draftId"], async (value) => unwrap(await c.getLibraryImportDraft(requiredString(asRecord(value).draftId, "draftId")))),
    tool("southstar.library.install_import_candidates", "Install selected Library import candidates.", { draftId: stringSchema("Import draft id."), selectedCandidateIds: arraySchema("Candidate ids."), selectedEdgeIds: arraySchema("Edge ids."), actor: optionalStringSchema("Actor id."), reason: stringSchema("Reason.") }, ["draftId", "selectedCandidateIds", "reason"], async (value) => {
      const body = asRecord(value);
      return withInstalledGoalDesign(unwrap(await c.installLibraryImportCandidates({
        draftId: requiredString(body.draftId, "draftId"),
        selectedCandidateIds: stringArray(body.selectedCandidateIds, "selectedCandidateIds"),
        ...(Array.isArray(body.selectedEdgeIds) ? { selectedEdgeIds: stringArray(body.selectedEdgeIds, "selectedEdgeIds") } : {}),
        ...(optionalString(body.actor) ? { actor: optionalString(body.actor) } : {}),
        reason: requiredString(body.reason, "reason"),
      })));
    }),
    tool("southstar.library.install_import_candidates_stream", "Install selected Library import candidates and stream progress.", { draftId: stringSchema("Import draft id."), selectedCandidateIds: arraySchema("Candidate ids."), selectedEdgeIds: arraySchema("Edge ids."), actor: optionalStringSchema("Actor id."), reason: stringSchema("Reason.") }, ["draftId", "selectedCandidateIds", "reason"], async (value, context) => {
      const body = asRecord(value);
      return withInstalledGoalDesign(await c.installLibraryImportCandidatesStream({
        draftId: requiredString(body.draftId, "draftId"),
        selectedCandidateIds: stringArray(body.selectedCandidateIds, "selectedCandidateIds"),
        ...(Array.isArray(body.selectedEdgeIds) ? { selectedEdgeIds: stringArray(body.selectedEdgeIds, "selectedEdgeIds") } : {}),
        ...(optionalString(body.actor) ? { actor: optionalString(body.actor) } : {}),
        reason: requiredString(body.reason, "reason"),
      }, context.onEvent ?? noopEvent, context.signal));
    }),
    tool("southstar.library.get_object", "Read a Library object.", { objectKey: stringSchema("Library object key.") }, ["objectKey"], async (value) => unwrap(await c.getLibraryObject(requiredString(asRecord(value).objectKey, "objectKey")))),
    tool("southstar.library.set_object_lifecycle", "Approve, deprecate, or block a Library object.", { objectKey: stringSchema("Object key."), action: stringSchema("approve, deprecate, or block."), actor: optionalStringSchema("Actor."), reason: stringSchema("Reason.") }, ["objectKey", "action", "reason"], async (value) => {
      const body = asRecord(value);
      return unwrap(await c.setLibraryObjectLifecycle({
        objectKey: requiredString(body.objectKey, "objectKey"),
        action: enumValue(body.action, ["approve", "deprecate", "block"], "action"),
        ...(optionalString(body.actor) ? { actor: optionalString(body.actor) } : {}),
        reason: requiredString(body.reason, "reason"),
      }));
    }),
    tool("southstar.library.list_files", "List Library files.", {}, [], async () => unwrap(await c.listLibraryFiles())),
    tool("southstar.library.get_file", "Read a Library file.", { relativePath: stringSchema("Library relative path.") }, ["relativePath"], async (value) => unwrap(await c.getLibraryFile(requiredString(asRecord(value).relativePath, "relativePath")))),
    tool("southstar.library.update_file", "Update a Library file.", { relativePath: stringSchema("Library relative path."), content: stringSchema("File content.") }, ["relativePath", "content"], async (value) => {
      const body = asRecord(value);
      return unwrap(await c.updateLibraryFile({ relativePath: requiredString(body.relativePath, "relativePath"), content: requiredString(body.content, "content") }));
    }),
    tool("southstar.library.validate_file", "Validate a Library file.", { relativePath: stringSchema("Library relative path.") }, ["relativePath"], async (value) => unwrap(await c.validateLibraryFile(requiredString(asRecord(value).relativePath, "relativePath")))),
    tool("southstar.library.sync_file", "Sync a Library file to the graph.", { relativePath: stringSchema("Library relative path.") }, ["relativePath"], async (value) => unwrap(await c.syncLibraryFile(requiredString(asRecord(value).relativePath, "relativePath")))),
    tool("southstar.library.compose_profile", "Compose a generated node profile draft.", { scope: optionalStringSchema("Scope."), nodeId: stringSchema("Node id."), requirement: stringSchema("Requirement."), preferredAgentRef: stringSchema("Preferred agent ref."), templateId: optionalStringSchema("Template id.") }, ["nodeId", "requirement", "preferredAgentRef"], async (value) => {
      const body = asRecord(value);
      return unwrap(await c.composeLibraryProfile({
        ...optionalScope(body),
        nodeId: requiredString(body.nodeId, "nodeId"),
        requirement: requiredString(body.requirement, "requirement"),
        preferredAgentRef: requiredString(body.preferredAgentRef, "preferredAgentRef"),
        ...(optionalString(body.templateId) ? { templateId: optionalString(body.templateId) } : {}),
      }));
    }),
    tool("southstar.library.validate_profile", "Validate a generated node profile.", { profile: optionalObjectSchema("Profile."), draft: optionalObjectSchema("Draft.") }, [], async (value) => unwrap(await c.validateLibraryProfile(asRecord(value)))),
    tool("southstar.library.save_profile", "Save a generated node profile.", { draft: optionalObjectSchema("Draft."), templateId: stringSchema("Template id."), actor: optionalStringSchema("Actor."), reason: stringSchema("Reason.") }, ["draft", "templateId", "reason"], async (value) => {
      const body = asRecord(value);
      return unwrap(await c.saveLibraryProfile({ draft: requiredValue(body.draft, "draft"), templateId: requiredString(body.templateId, "templateId"), ...(optionalString(body.actor) ? { actor: optionalString(body.actor) } : {}), reason: requiredString(body.reason, "reason") }));
    }),

    tool("southstar.workflow.create_draft", "Create a planner draft from a prompt.", plannerDraftSchema(), ["goalPrompt"], async (value) => unwrap(await c.createPlannerDraft(plannerDraftBody(asRecord(value))))),
    tool("southstar.workflow.create_draft_stream", "Create a planner draft from a prompt and stream backend progress.", plannerDraftSchema(), ["goalPrompt"], async (value, context) => await c.createPlannerDraftStream(plannerDraftBody(asRecord(value)), context.onEvent ?? noopEvent, context.signal)),
    tool("southstar.workflow.run_goal", "Execute a complete natural-language Southstar goal through Goal, Requirements, Library coverage, Slices, DAG, Executor, and persisted runtime evaluation.", runGoalSchema(), ["goalPrompt", "cwd", "idempotencyKey"], async (value, context) => runGoal(c, asRecord(value), context)),
    tool("southstar.workflow.revise_requirement", "Revise one goal requirement with optimistic draft-hash concurrency protection.", { draftId: stringSchema("Goal requirement draft id."), requirementId: stringSchema("Requirement id."), expectedDraftHash: stringSchema("Expected draft hash."), patch: optionalObjectSchema("Requirement patch."), actor: optionalStringSchema("Actor id.") }, ["draftId", "requirementId", "expectedDraftHash", "patch"], async (value) => unwrap(await c.reviseGoalRequirement(reviseGoalRequirementBody(asRecord(value))))),
    tool("southstar.workflow.confirm_requirements", "Confirm a goal requirement draft and continue composition.", { draftId: stringSchema("Goal requirement draft id."), expectedDraftHash: stringSchema("Expected draft hash."), actor: optionalStringSchema("Actor id.") }, ["draftId", "expectedDraftHash"], async (value) => confirmRequirements(c, asRecord(value))),
    tool("southstar.workflow.confirm_goal_design", "Confirm the validated goal-design package, create its workflow run, and start scheduling.", { draftId: stringSchema("Planner draft id."), expectedPackageHash: stringSchema("Expected goal-design package hash.") }, ["draftId", "expectedPackageHash"], async (value) => confirmGoalDesign(c, asRecord(value))),
    tool("southstar.workflow.confirm_goal_design_stream", "Confirm the validated goal-design package while streaming composition progress, then return its DAG and workflow run.", { draftId: stringSchema("Planner draft id."), expectedPackageHash: stringSchema("Expected goal-design package hash.") }, ["draftId", "expectedPackageHash"], async (value, context) => confirmGoalDesignStream(c, asRecord(value), context)),
    tool("southstar.workflow.search_templates", "Search approved workflow templates.", { prompt: stringSchema("Prompt."), domain: optionalStringSchema("Domain."), limit: optionalNumberSchema("Limit.") }, ["prompt"], async (value) => {
      const body = asRecord(value);
      return unwrap(await c.searchWorkflowTemplates({ prompt: requiredString(body.prompt, "prompt"), ...(optionalString(body.domain) ? { domain: optionalString(body.domain) } : {}), ...(optionalNumber(body.limit) !== undefined ? { limit: optionalNumber(body.limit) } : {}) }));
    }),
    tool("southstar.workflow.get_template", "Read a workflow template.", { templateRef: stringSchema("Template ref.") }, ["templateRef"], async (value) => unwrap(await c.getWorkflowTemplate(requiredString(asRecord(value).templateRef, "templateRef")))),
    tool("southstar.workflow.instantiate_template", "Instantiate a workflow template.", { templateRef: stringSchema("Template ref."), goalPrompt: stringSchema("Goal prompt."), cwd: optionalStringSchema("Workspace path."), repo: optionalObjectSchema("Repo."), constraints: optionalObjectSchema("Constraints.") }, ["templateRef", "goalPrompt"], async (value) => unwrap(await c.instantiateWorkflowTemplate(instantiateTemplateBody(asRecord(value))))),
    tool("southstar.workflow.revise_draft", "Revise a planner draft.", { draftId: stringSchema("Draft id."), prompt: stringSchema("Revision prompt."), orchestrationMode: optionalStringSchema("Mode."), composerMode: optionalStringSchema("Composer mode.") }, ["draftId", "prompt"], async (value) => unwrap(await c.revisePlannerDraft(reviseDraftBody(asRecord(value))))),
    tool("southstar.workflow.revise_draft_stream", "Revise a planner draft and stream backend progress.", { draftId: stringSchema("Draft id."), prompt: stringSchema("Revision prompt."), orchestrationMode: optionalStringSchema("Mode."), composerMode: optionalStringSchema("Composer mode.") }, ["draftId", "prompt"], async (value, context) => await c.revisePlannerDraftStream(reviseDraftBody(asRecord(value)), context.onEvent ?? noopEvent, context.signal)),
    tool("southstar.workflow.get_draft", "Read planner draft orchestration.", { draftId: stringSchema("Draft id.") }, ["draftId"], async (value) => unwrap(await c.getPlannerDraftOrchestration(requiredString(asRecord(value).draftId, "draftId")))),
    tool("southstar.workflow.list_proposals", "List planner draft proposals.", { draftId: stringSchema("Draft id.") }, ["draftId"], async (value) => unwrap(await c.listPlannerDraftProposals(requiredString(asRecord(value).draftId, "draftId")))),
    tool("southstar.workflow.approve_proposal", "Approve a planner draft proposal.", proposalDecisionSchema(), ["draftId", "proposalId"], async (value) => unwrap(await c.approvePlannerDraftProposal(proposalDecisionBody(asRecord(value))))),
    tool("southstar.workflow.reject_proposal", "Reject a planner draft proposal.", proposalDecisionSchema(), ["draftId", "proposalId"], async (value) => unwrap(await c.rejectPlannerDraftProposal(proposalDecisionBody(asRecord(value))))),
    tool("southstar.workflow.convert_proposal_to_library_draft", "Convert a proposal into a Library draft.", proposalDecisionSchema(), ["draftId", "proposalId"], async (value) => unwrap(await c.convertPlannerDraftProposalToLibraryDraft(proposalDecisionBody(asRecord(value))))),
    tool("southstar.workflow.save_template", "Save a planner draft DAG as a workflow template.", { draftId: stringSchema("Draft id."), templateId: stringSchema("Template id."), title: stringSchema("Title."), scope: optionalStringSchema("Scope."), status: optionalStringSchema("draft or approved.") }, ["draftId", "templateId", "title"], async (value) => unwrap(await c.saveWorkflowTemplate(saveTemplateBody(asRecord(value))))),
    tool("southstar.workflow.run_draft", "Create a workflow run from a validated draft.", { draftId: stringSchema("Draft id.") }, ["draftId"], async (value) => unwrap(await c.createRunFromPlannerDraft(requiredString(asRecord(value).draftId, "draftId")))),
    tool("southstar.workflow.inspect_run", "Inspect a workflow run or task.", { runId: stringSchema("Run id."), taskId: optionalStringSchema("Task id.") }, ["runId"], async (value) => inspectRun(c, asRecord(value))),
    tool("southstar.workflow.get_artifact", "Read artifact content.", { artifactRef: stringSchema("Artifact ref.") }, ["artifactRef"], async (value) => unwrap(await c.getArtifact({ artifactRef: requiredString(asRecord(value).artifactRef, "artifactRef") }))),

    tool("southstar.runtime.get_read_model", "Read a runtime read model.", { kind: stringSchema("Read model kind."), runId: stringSchema("Run id."), taskId: optionalStringSchema("Task id.") }, ["kind", "runId"], async (value) => unwrap(await c.getReadModel(readModelBody(asRecord(value))))),
    tool("southstar.runtime.get_task_envelope", "Read task envelope.", runTaskSchema(), ["runId", "taskId"], async (value) => unwrap(await c.getTaskEnvelope(runTaskBody(asRecord(value))))),
    tool("southstar.runtime.get_run_actions", "Read allowed run actions.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.getRunActions(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.control_run", "Pause, resume, or cancel a run.", runtimeCommandSchema({ action: stringSchema("pause, resume, or cancel.") }), ["runId", "action", "commandId"], async (value) => controlRun(c, asRecord(value))),
    tool("southstar.runtime.get_task_actions", "Read allowed task actions.", runTaskSchema(), ["runId", "taskId"], async (value) => unwrap(await c.getTaskActions(runTaskBody(asRecord(value))))),
    tool("southstar.runtime.recover_task", "Queue a task recovery action.", runtimeCommandSchema({ taskId: stringSchema("Task id."), action: stringSchema("retry, fork-session, reset-session, rollback-session, or request-revision.") }), ["runId", "taskId", "action", "commandId"], async (value) => recoverTask(c, asRecord(value))),
    tool("southstar.runtime.list_artifacts", "List run artifacts.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listArtifacts(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.list_sessions", "List run sessions.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listSessions(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.get_session_events", "Read session events.", { sessionId: stringSchema("Session id.") }, ["sessionId"], async (value) => unwrap(await c.getSessionEvents(sessionEventsBody(asRecord(value))))),
    tool("southstar.runtime.get_session_checkpoints", "Read session checkpoints.", { sessionId: stringSchema("Session id.") }, ["sessionId"], async (value) => unwrap(await c.getSessionCheckpoints(requiredString(asRecord(value).sessionId, "sessionId")))),
    tool("southstar.runtime.search_memory", "Search run memory.", { runId: stringSchema("Run id."), query: stringSchema("Query."), scopes: arraySchema("Scopes."), allowedKinds: arraySchema("Allowed kinds."), maxCandidates: optionalNumberSchema("Max candidates.") }, ["runId", "query", "scopes", "allowedKinds"], async (value) => unwrap(await c.searchMemory(searchMemoryBody(asRecord(value))))),
    tool("southstar.runtime.list_memory", "List run memory.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listMemory(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.list_memory_deltas", "List memory deltas.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listMemoryDeltas(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.decide_memory_delta", "Approve or reject a memory delta.", { action: stringSchema("approve or reject."), deltaId: stringSchema("Delta id."), actor: optionalStringSchema("Actor."), reason: stringSchema("Reason.") }, ["action", "deltaId", "reason"], async (value) => decideMemoryDelta(c, asRecord(value))),
    tool("southstar.runtime.list_executions", "List hand executions.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listExecutions(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.get_execution", "Read one hand execution.", { runId: stringSchema("Run id."), executionId: stringSchema("Execution id.") }, ["runId", "executionId"], async (value) => unwrap(await c.getExecution({ runId: requiredString(asRecord(value).runId, "runId"), executionId: requiredString(asRecord(value).executionId, "executionId") }))),
    tool("southstar.runtime.reconcile_executor_job", "Reconcile an executor job.", { runId: stringSchema("Run id."), jobId: stringSchema("Job id.") }, ["runId", "jobId"], async (value) => unwrap(await c.reconcileExecutorJob(jobBody(asRecord(value))))),
    tool("southstar.runtime.cancel_executor_job", "Cancel an executor job.", runtimeCommandSchema({ jobId: stringSchema("Job id.") }), ["runId", "jobId", "commandId"], async (value) => unwrap(await c.cancelExecutorJob({ ...jobBody(asRecord(value)), ...runtimeCommand(asRecord(value)) }))),
    tool("southstar.runtime.list_logs", "List run logs.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listLogs(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.list_approvals", "List run approvals.", { runId: stringSchema("Run id.") }, ["runId"], async (value) => unwrap(await c.listApprovals(requiredString(asRecord(value).runId, "runId")))),
    tool("southstar.runtime.decide_approval", "Approve or reject a runtime approval.", { runId: stringSchema("Run id."), approvalId: stringSchema("Approval id."), decision: stringSchema("approved or rejected."), reason: stringSchema("Reason.") }, ["runId", "approvalId", "decision", "reason"], async (value) => unwrap(await c.decideApproval(approvalDecisionBody(asRecord(value))))),
    tool("southstar.runtime.approve_recovery_decision", "Approve or reject a recovery decision.", { runId: stringSchema("Run id."), decisionId: stringSchema("Decision id."), decision: stringSchema("approved or rejected."), reason: stringSchema("Reason.") }, ["runId", "decisionId", "decision", "reason"], async (value) => unwrap(await c.approveRecoveryDecision(recoveryDecisionBody(asRecord(value))))),
    tool("southstar.runtime.apply_recovery_decision", "Apply an approved recovery decision.", { runId: stringSchema("Run id."), decisionId: stringSchema("Decision id.") }, ["runId", "decisionId"], async (value) => unwrap(await c.applyRecoveryDecision({ runId: requiredString(asRecord(value).runId, "runId"), decisionId: requiredString(asRecord(value).decisionId, "decisionId") }))),
    tool("southstar.runtime.steer_run", "Send steering text to a run.", { runId: stringSchema("Run id."), message: stringSchema("Steering message.") }, ["runId", "message"], async (value) => unwrap(await c.steerRun({ runId: requiredString(asRecord(value).runId, "runId"), message: requiredString(asRecord(value).message, "message") }))),
    tool("southstar.runtime.stream_run_events", "Stream durable runtime events for a run.", { runId: stringSchema("Run id."), after: optionalNumberSchema("After sequence."), taskId: optionalStringSchema("Task id."), includeRunEvents: { type: "boolean" }, closeOnTerminal: { type: "boolean" }, pollMs: optionalNumberSchema("Poll ms."), heartbeatMs: optionalNumberSchema("Heartbeat ms.") }, ["runId"], async (value, context) => await c.streamRunEvents(streamRunEventsBody(asRecord(value)), context.onEvent ?? noopEvent, context.signal)),
  ];

  return {
    listTools() {
      return tools.map(({ call: _call, ...tool }) => tool);
    },
    async callTool(name: string, value: unknown, context: SouthstarMcpToolCallContext = {}) {
      const selectedTool = tools.find((candidate) => candidate.name === name);
      if (!selectedTool) throw new Error(`unknown Southstar MCP tool: ${name}`);
      const structuredContent = await selectedTool.call(value, context);
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  call: (value: unknown, context: SouthstarMcpToolCallContext) => Promise<unknown>,
): ToolDefinition {
  return { name, description, inputSchema: objectSchema(properties, required), call };
}

function noopEvent(_event: SouthstarMcpStreamEvent): void {}

function unwrap(envelope: ApiEnvelope<unknown>): unknown {
  return envelope.result;
}

function withInstalledGoalDesign(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  const resume = asRecord(result.goalValidationResume);
  const continued = asRecord(resume.continued);
  if (typeof continued.draftId !== "string" || !isRecord(continued.goalDesignPackage)) return result;
  return {
    ...result,
    goalDesign: {
      type: "goalDesign",
      draftId: continued.draftId,
      status: continued.status,
      goalDesignPackageHash: continued.goalDesignPackageHash,
      package: continued.goalDesignPackage,
    },
  };
}

async function runGoal(
  client: SouthstarMcpRuntimeClient,
  body: Record<string, unknown>,
  context: SouthstarMcpToolCallContext,
): Promise<Record<string, unknown>> {
  const summary = asRecord(await client.runGoalStream(runGoalBody(body), context.onEvent ?? noopEvent, context.signal));
  const result = asRecord(summary.result);
  const events = Array.isArray(summary.events) ? summary.events : [];
  const goalDesignFrame = events
    .map((event) => asRecord(event))
    .filter((event) => event.event === "goal_design")
    .map((event) => asRecord(event.data))
    .find((data) => data.package !== undefined);
  const goalRequirementDraft = result.goalRequirementDraft;
  const output: Record<string, unknown> = {
    kind: "southstar.workflow.run_goal",
    ...result,
    ...(summary.eventCount !== undefined ? { eventCount: summary.eventCount } : {}),
    ...(events.length > 0 ? { events } : {}),
  };
  if (isRecord(goalRequirementDraft)) {
    output.goalRequirements = {
      type: "goalRequirements",
      draftId: typeof result.goalRequirementDraftId === "string" ? result.goalRequirementDraftId : result.draftId,
      status: typeof result.goalDesignPhase === "string" ? result.goalDesignPhase : result.draftStatus,
      goalRequirementDraftHash: result.goalRequirementDraftHash,
      draft: goalRequirementDraft,
      confirmable: result.confirmable === true,
      blockers: Array.isArray(result.blockers) ? result.blockers : [],
      validationIssues: Array.isArray(result.validationIssues) ? result.validationIssues : [],
    };
  }
  if (goalDesignFrame && typeof result.draftId === "string") {
    output.goalDesign = {
      type: "goalDesign",
      draftId: result.draftId,
      status: typeof result.draftStatus === "string" ? result.draftStatus : undefined,
      goalDesignPackageHash: result.goalDesignPackageHash,
      package: goalDesignFrame.package,
    };
  }
  if (typeof result.draftId === "string") {
    try {
      output.orchestration = unwrap(await client.getPlannerDraftOrchestration(result.draftId));
    } catch (error) {
      output.orchestrationError = error instanceof Error ? error.message : String(error);
    }
  }
  return output;
}

async function confirmRequirements(
  client: SouthstarMcpRuntimeClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = asRecord(unwrap(await client.confirmGoalRequirements({
    draftId: requiredString(body.draftId, "draftId"),
    expectedDraftHash: requiredString(body.expectedDraftHash, "expectedDraftHash"),
    ...(optionalString(body.actor) ? { actor: optionalString(body.actor) } : {}),
  })));
  const goalDesignPackage = asRecord(result.goalDesignPackage);
  return {
    ...result,
    ...(goalDesignPackage && typeof result.draftId === "string" ? {
      goalDesign: {
        type: "goalDesign",
        draftId: result.draftId,
        status: result.status,
        goalDesignPackageHash: result.goalDesignPackageHash,
        package: goalDesignPackage,
      },
    } : {}),
  };
}

async function confirmGoalDesign(
  client: SouthstarMcpRuntimeClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = asRecord(unwrap(await client.confirmGoalDesign({
    draftId: requiredString(body.draftId, "draftId"),
    expectedPackageHash: requiredString(body.expectedPackageHash, "expectedPackageHash"),
  })));
  if (typeof result.draftId !== "string") return result;
  try {
    return {
      ...result,
      orchestration: unwrap(await client.getPlannerDraftOrchestration(result.draftId)),
    };
  } catch (error) {
    return {
      ...result,
      orchestrationError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function confirmGoalDesignStream(
  client: SouthstarMcpRuntimeClient,
  body: Record<string, unknown>,
  context: SouthstarMcpToolCallContext,
): Promise<Record<string, unknown>> {
  const draftId = requiredString(body.draftId, "draftId");
  const summary = asRecord(await client.confirmGoalDesignStream({
    draftId,
    expectedPackageHash: requiredString(body.expectedPackageHash, "expectedPackageHash"),
  }, context.onEvent ?? noopEvent, context.signal));
  const result = asRecord(summary.result);
  const orchestrationDraftId = typeof result.draftId === "string" ? result.draftId : draftId;
  try {
    const orchestration = unwrap(await client.getPlannerDraftOrchestration(orchestrationDraftId));
    return {
      ...summary,
      orchestration,
      result: { ...result, orchestration },
    };
  } catch (error) {
    return {
      ...summary,
      orchestrationError: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectRun(client: SouthstarMcpRuntimeClient, body: Record<string, unknown>): Promise<unknown> {
  const runId = requiredString(body.runId, "runId");
  const taskId = optionalString(body.taskId);
  if (taskId) return client.getTask({ runId, taskId }).then(unwrap);
  return client.getRun(runId).then(unwrap);
}

function controlRun(client: SouthstarMcpRuntimeClient, body: Record<string, unknown>): Promise<unknown> {
  const input = { runId: requiredString(body.runId, "runId"), ...runtimeCommand(body) };
  const action = enumValue(body.action, ["pause", "resume", "cancel"], "action");
  if (action === "pause") return client.pauseRun(input).then(unwrap);
  if (action === "resume") return client.resumeRun(input).then(unwrap);
  return client.cancelRun(input).then(unwrap);
}

function recoverTask(client: SouthstarMcpRuntimeClient, body: Record<string, unknown>): Promise<unknown> {
  const input = { ...runTaskBody(body), ...runtimeCommand(body) };
  const action = enumValue(body.action, ["retry", "fork-session", "reset-session", "rollback-session", "request-revision"], "action");
  if (action === "retry") return client.retryTask(input).then(unwrap);
  if (action === "fork-session") return client.forkTaskSession(input).then(unwrap);
  if (action === "reset-session") return client.resetTaskSession(input).then(unwrap);
  if (action === "rollback-session") return client.rollbackTaskSession(input).then(unwrap);
  return client.requestTaskRevision(input).then(unwrap);
}

function decideMemoryDelta(client: SouthstarMcpRuntimeClient, body: Record<string, unknown>): Promise<unknown> {
  const action = enumValue(body.action, ["approve", "reject"], "action");
  const deltaId = requiredString(body.deltaId, "deltaId");
  const actor = optionalString(body.actor) ?? "pi-agent";
  const reason = requiredString(body.reason, "reason");
  if (action === "approve") return client.approveMemoryDelta({ deltaId, approvedBy: actor, reason }).then(unwrap);
  return client.rejectMemoryDelta({ deltaId, rejectedBy: actor, reason }).then(unwrap);
}

function runtimeCommand(body: Record<string, unknown>): RuntimeCommandRequest {
  const payload = isRecord(body.payload) ? body.payload : undefined;
  return {
    commandId: requiredString(body.commandId, "commandId"),
    actor: actor(body.actor),
    ...(optionalString(body.reason) ? { reason: optionalString(body.reason) } : {}),
    ...(typeof body.dryRun === "boolean" ? { dryRun: body.dryRun } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

function actor(value: unknown): RuntimeCommandRequest["actor"] {
  if (isRecord(value)) {
    const requestedType = optionalString(value.type);
    const type = requestedType === "system" || requestedType === "root-session" ? requestedType : "user";
    return {
      type,
      ...(optionalString(value.id) ? { id: optionalString(value.id) } : { id: "pi-agent" }),
    };
  }
  return { type: "user", id: optionalString(value) ?? "pi-agent" };
}

function plannerDraftBody(body: Record<string, unknown>): { goalPrompt: string; orchestrationMode?: "llm-constrained"; composerMode?: "llm"; scope?: string } {
  return {
    goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
    ...(body.orchestrationMode === "llm-constrained" ? { orchestrationMode: body.orchestrationMode } : {}),
    ...(body.composerMode === "llm" ? { composerMode: body.composerMode } : {}),
    ...(optionalString(body.scope) ? { scope: optionalString(body.scope) } : {}),
  };
}

function runGoalBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["runGoalStream"]>[0] {
  const goalDesignMode = body.goalDesignMode === undefined
    ? "auto_until_blocked"
    : enumValue(body.goalDesignMode, ["review_before_compose", "auto_until_blocked"], "goalDesignMode");
  const templatePolicy = isRecord(body.templatePolicy)
    ? workflowTemplatePolicy(body.templatePolicy)
    : { mode: "auto" as const };
  return {
    goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
    cwd: requiredString(body.cwd, "cwd"),
    idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey"),
    ...(optionalString(body.projectRef) ? { projectRef: optionalString(body.projectRef) } : {}),
    goalDesignMode,
    templatePolicy,
  };
}

function workflowTemplatePolicy(body: Record<string, unknown>): { mode: "auto" | "prefer" | "require"; templateRef?: string; versionRef?: string } {
  const mode = enumValue(body.mode, ["auto", "prefer", "require"], "templatePolicy.mode");
  if (mode === "auto") return { mode };
  return {
    mode,
    templateRef: requiredString(body.templateRef, "templatePolicy.templateRef"),
    versionRef: requiredString(body.versionRef, "templatePolicy.versionRef"),
  };
}

function instantiateTemplateBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["instantiateWorkflowTemplate"]>[0] {
  return {
    templateRef: requiredString(body.templateRef, "templateRef"),
    goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
    ...(optionalString(body.cwd) ? { cwd: optionalString(body.cwd) } : {}),
    ...(isRecord(body.repo) ? { repo: optionalStringObject(body.repo, ["path", "url", "branch"]) } : {}),
    ...(isRecord(body.constraints) ? { constraints: parseConstraints(body.constraints) } : {}),
  };
}

function reviseDraftBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["revisePlannerDraft"]>[0] {
  return {
    draftId: requiredString(body.draftId, "draftId"),
    prompt: requiredString(body.prompt, "prompt"),
    ...(body.orchestrationMode === "llm-constrained" ? { orchestrationMode: body.orchestrationMode } : {}),
    ...(body.composerMode === "llm" ? { composerMode: body.composerMode } : {}),
  };
}

function reviseGoalRequirementBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["reviseGoalRequirement"]>[0] {
  return {
    draftId: requiredString(body.draftId, "draftId"),
    requirementId: requiredString(body.requirementId, "requirementId"),
    expectedDraftHash: requiredString(body.expectedDraftHash, "expectedDraftHash"),
    patch: requiredValue(body.patch, "patch"),
    ...(optionalString(body.actor) ? { actor: optionalString(body.actor) } : {}),
  };
}

function proposalDecisionBody(body: Record<string, unknown>): { draftId: string; proposalId: string; actorId?: string; reason?: string } {
  return {
    draftId: requiredString(body.draftId, "draftId"),
    proposalId: requiredString(body.proposalId, "proposalId"),
    ...(optionalString(body.actorId) ? { actorId: optionalString(body.actorId) } : {}),
    ...(optionalString(body.reason) ? { reason: optionalString(body.reason) } : {}),
  };
}

function saveTemplateBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["saveWorkflowTemplate"]>[0] {
  return {
    draftId: requiredString(body.draftId, "draftId"),
    templateId: requiredString(body.templateId, "templateId"),
    title: requiredString(body.title, "title"),
    ...(optionalString(body.scope) ? { scope: optionalString(body.scope) } : {}),
    ...(body.status === "draft" || body.status === "approved" ? { status: body.status } : {}),
  };
}

function readModelBody(body: Record<string, unknown>): { kind: ReadModelKind; runId: string; taskId?: string } {
  return {
    kind: requiredString(body.kind, "kind") as ReadModelKind,
    runId: requiredString(body.runId, "runId"),
    ...(optionalString(body.taskId) ? { taskId: optionalString(body.taskId) } : {}),
  };
}

function runTaskBody(body: Record<string, unknown>): { runId: string; taskId: string } {
  return {
    runId: requiredString(body.runId, "runId"),
    taskId: requiredString(body.taskId, "taskId"),
  };
}

function jobBody(body: Record<string, unknown>): { runId: string; jobId: string } {
  return {
    runId: requiredString(body.runId, "runId"),
    jobId: requiredString(body.jobId, "jobId"),
  };
}

function sessionEventsBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["getSessionEvents"]>[0] {
  return {
    sessionId: requiredString(body.sessionId, "sessionId"),
    ...(optionalNumber(body.afterSequence) !== undefined ? { afterSequence: optionalNumber(body.afterSequence) } : {}),
    ...(optionalNumber(body.beforeSequence) !== undefined ? { beforeSequence: optionalNumber(body.beforeSequence) } : {}),
    ...(optionalNumber(body.limit) !== undefined ? { limit: optionalNumber(body.limit) } : {}),
    ...(Array.isArray(body.eventTypes) ? { eventTypes: stringArray(body.eventTypes, "eventTypes") } : {}),
    ...(optionalString(body.taskId) ? { taskId: optionalString(body.taskId) } : {}),
    ...(optionalString(body.correlationId) ? { correlationId: optionalString(body.correlationId) } : {}),
    ...(optionalString(body.artifactRef) ? { artifactRef: optionalString(body.artifactRef) } : {}),
    ...(optionalString(body.aroundEventId) ? { aroundEventId: optionalString(body.aroundEventId) } : {}),
    ...(optionalNumber(body.windowBefore) !== undefined ? { windowBefore: optionalNumber(body.windowBefore) } : {}),
    ...(optionalNumber(body.windowAfter) !== undefined ? { windowAfter: optionalNumber(body.windowAfter) } : {}),
  };
}

function searchMemoryBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["searchMemory"]>[0] {
  return {
    runId: requiredString(body.runId, "runId"),
    query: requiredString(body.query, "query"),
    scopes: stringArray(body.scopes, "scopes"),
    allowedKinds: stringArray(body.allowedKinds, "allowedKinds"),
    ...(optionalNumber(body.maxCandidates) !== undefined ? { maxCandidates: optionalNumber(body.maxCandidates) } : {}),
  };
}

function streamRunEventsBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["streamRunEvents"]>[0] {
  return {
    runId: requiredString(body.runId, "runId"),
    ...(optionalNumber(body.after) !== undefined ? { after: optionalNumber(body.after) } : {}),
    ...(optionalString(body.taskId) ? { taskId: optionalString(body.taskId) } : {}),
    ...(typeof body.includeRunEvents === "boolean" ? { includeRunEvents: body.includeRunEvents } : {}),
    ...(typeof body.closeOnTerminal === "boolean" ? { closeOnTerminal: body.closeOnTerminal } : {}),
    ...(optionalNumber(body.pollMs) !== undefined ? { pollMs: optionalNumber(body.pollMs) } : {}),
    ...(optionalNumber(body.heartbeatMs) !== undefined ? { heartbeatMs: optionalNumber(body.heartbeatMs) } : {}),
  };
}

function approvalDecisionBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["decideApproval"]>[0] {
  return {
    runId: requiredString(body.runId, "runId"),
    approvalId: requiredString(body.approvalId, "approvalId"),
    decision: enumValue(body.decision, ["approved", "rejected"], "decision"),
    reason: requiredString(body.reason, "reason"),
  };
}

function recoveryDecisionBody(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["approveRecoveryDecision"]>[0] {
  return {
    runId: requiredString(body.runId, "runId"),
    decisionId: requiredString(body.decisionId, "decisionId"),
    decision: enumValue(body.decision, ["approved", "rejected"], "decision"),
    reason: requiredString(body.reason, "reason"),
  };
}

function graphQuery(body: Record<string, unknown>): Parameters<SouthstarMcpRuntimeClient["getLibraryGraph"]>[0] {
  return {
    ...(optionalString(body.scope) ? { scope: optionalString(body.scope) } : {}),
    ...(optionalString(body.objectKey) ? { objectKey: optionalString(body.objectKey) } : {}),
    ...(optionalNumber(body.depth) !== undefined ? { depth: optionalNumber(body.depth) } : {}),
    ...(optionalString(body.kind) ? { kind: optionalString(body.kind) } : {}),
    ...(optionalString(body.status) ? { status: optionalString(body.status) } : {}),
    ...(optionalString(body.edgeType) ? { edgeType: optionalString(body.edgeType) } : {}),
  };
}

function optionalRunTask(body: Record<string, unknown>): { runId?: string; taskId?: string } {
  return {
    ...(optionalString(body.runId) ? { runId: optionalString(body.runId) } : {}),
    ...(optionalString(body.taskId) ? { taskId: optionalString(body.taskId) } : {}),
  };
}

function optionalScope(body: Record<string, unknown>): { scope?: string } {
  return optionalString(body.scope) ? { scope: optionalString(body.scope) } : {};
}

function parseConstraints(body: Record<string, unknown>): { mode?: "strict" | "adaptive"; maxNodes?: number; requireApproval?: boolean } {
  return {
    ...(body.mode === "strict" || body.mode === "adaptive" ? { mode: body.mode } : {}),
    ...(optionalNumber(body.maxNodes) !== undefined ? { maxNodes: optionalNumber(body.maxNodes) } : {}),
    ...(typeof body.requireApproval === "boolean" ? { requireApproval: body.requireApproval } : {}),
  };
}

function optionalStringObject(body: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => optionalString(body[key]) ? [[key, optionalString(body[key])!]] : []));
}

function runtimeLoopId(value: unknown): RuntimeLoopId {
  return enumValue(value, ["executor-reconciler", "runnable-task-scheduler", "recovery-controller", "tork-exception-observer", "recovery-decision-applier"], "loopId");
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`${field} must be one of ${allowed.join(", ")}`);
}

function requiredValue(value: unknown, field: string): unknown {
  if (value === undefined || value === null) throw new Error(`${field} is required`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const invalid = value.find((item) => typeof item !== "string" || item.length === 0);
  if (invalid !== undefined) throw new Error(`${field} must contain non-empty strings`);
  return value as string[];
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function graphSchema(): Record<string, unknown> {
  return {
    scope: optionalStringSchema("Scope."),
    objectKey: optionalStringSchema("Object key."),
    depth: optionalNumberSchema("Depth."),
    kind: optionalStringSchema("Kind."),
    status: optionalStringSchema("Status."),
    edgeType: optionalStringSchema("Edge type."),
  };
}

function plannerDraftSchema(): Record<string, unknown> {
  return {
    goalPrompt: stringSchema("Goal prompt."),
    orchestrationMode: optionalStringSchema("llm-constrained."),
    composerMode: optionalStringSchema("llm."),
    scope: optionalStringSchema("Scope."),
  };
}

function runGoalSchema(): Record<string, unknown> {
  return {
    goalPrompt: stringSchema("Complete natural-language goal."),
    cwd: stringSchema("Absolute workspace path."),
    projectRef: optionalStringSchema("Optional project reference."),
    idempotencyKey: stringSchema("Stable request idempotency key."),
    goalDesignMode: optionalStringSchema("review_before_compose or auto_until_blocked."),
    templatePolicy: optionalObjectSchema("auto, prefer, or require template policy."),
  };
}

function proposalDecisionSchema(): Record<string, unknown> {
  return {
    draftId: stringSchema("Draft id."),
    proposalId: stringSchema("Proposal id."),
    actorId: optionalStringSchema("Actor id."),
    reason: optionalStringSchema("Reason."),
  };
}

function runTaskSchema(): Record<string, unknown> {
  return {
    runId: stringSchema("Run id."),
    taskId: stringSchema("Task id."),
  };
}

function runtimeCommandSchema(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: stringSchema("Run id."),
    commandId: stringSchema("Command id."),
    actor: optionalObjectSchema("Actor."),
    reason: optionalStringSchema("Reason."),
    dryRun: { type: "boolean", description: "Dry run." },
    payload: optionalObjectSchema("Payload."),
    ...extra,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", minLength: 1, description };
}

function optionalStringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function optionalNumberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function optionalObjectSchema(description: string): Record<string, unknown> {
  return { type: "object", description, additionalProperties: true };
}

function arraySchema(description: string): Record<string, unknown> {
  return { type: "array", description, items: { type: "string" } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
