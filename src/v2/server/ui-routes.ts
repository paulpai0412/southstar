import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";
import { buildPlannerPageModel } from "../ui-api/page-models/planner.ts";
import { buildWorkflowCanvasPageModel } from "../ui-api/page-models/workflow-canvas.ts";
import { buildRuntimeMonitorPageModel } from "../ui-api/page-models/runtime-monitor.ts";
import { buildTaskDetailPageModel } from "../ui-api/page-models/task-detail.ts";
import { buildSessionsMemoryPageModel } from "../ui-api/page-models/sessions-memory.ts";
import { buildWorktreePageModel } from "../ui-api/page-models/worktree.ts";
import { buildExecutorOpsPageModel } from "../ui-api/page-models/executor.ts";
import { buildDomainPacksPageModel } from "../ui-api/page-models/domain-packs.ts";
import { buildGovernancePageModel } from "../ui-api/page-models/governance.ts";
import type { SouthstarCommandRequest } from "../ui-api/commands/types.ts";
import { rejectedCommand } from "../ui-api/commands/types.ts";
import { pauseRunCommand, resumeRunCommand, cancelRunCommand } from "../ui-api/commands/run-commands.ts";
import { retryTaskCommand, requestTaskSessionForkCommand, requestWorkflowRevisionCommand, rollbackWorkspaceCommand } from "../ui-api/commands/task-commands.ts";
import { forkSessionCommand, resetSessionCommand, rollbackSessionCommand, rewindSessionCommand, approveMemoryCommand, rejectMemoryCommand, doNotInjectMemoryCommand } from "../ui-api/commands/session-memory-commands.ts";
import { createWorktreeSnapshotCommand, previewWorktreeRollbackCommand, rollbackWorktreeCommand } from "../ui-api/commands/worktree-commands.ts";
import { retryExecutorJobCommand, cancelExecutorJobCommand, reconcileExecutorJobCommand } from "../ui-api/commands/executor-commands.ts";
import { validateDomainPackCommand, previewDomainPackWorkflowCommand, publishDomainPackCommand } from "../ui-api/commands/domain-pack-commands.ts";
import { addMcpConnectionCommand, addVaultSecretGroupCommand, simulateApprovalPolicyCommand, decideApprovalCommand } from "../ui-api/commands/governance-commands.ts";

export async function handleUiRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/v2/ui/planner") {
    return json("ui-planner", buildPlannerPageModel(context.db, { draftId: url.searchParams.get("draftId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/workflow-canvas") {
    return json("ui-workflow-canvas", buildWorkflowCanvasPageModel(context.db, { runId: requiredQuery(url, "runId"), selectedTaskId: url.searchParams.get("taskId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/runtime-monitor") {
    return json("ui-runtime-monitor", buildRuntimeMonitorPageModel(context.db, { runId: requiredQuery(url, "runId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/task-detail") {
    return json("ui-task-detail", buildTaskDetailPageModel(context.db, { runId: requiredQuery(url, "runId"), taskId: requiredQuery(url, "taskId") }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/sessions-memory") {
    return json("ui-sessions-memory", buildSessionsMemoryPageModel(context.db, { runId: url.searchParams.get("runId") ?? undefined, sessionId: url.searchParams.get("sessionId") ?? undefined }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/worktree") {
    return json("ui-worktree", buildWorktreePageModel(context.db, { runId: url.searchParams.get("runId") ?? undefined }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/executor") {
    return json("ui-executor", buildExecutorOpsPageModel(context.db, { jobId: url.searchParams.get("jobId") ?? undefined }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/domain-packs") {
    return json("ui-domain-packs", buildDomainPacksPageModel(context.db, { domainPackId: url.searchParams.get("domainPackId") ?? undefined }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/ui/governance") {
    return json("ui-governance", buildGovernancePageModel(context.db));
  }

  const runCommand = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(pause|resume|cancel)$/);
  if (request.method === "POST" && runCommand) {
    const runId = decodeURIComponent(runCommand[1]!);
    const body = await request.json() as SouthstarCommandRequest<{ cancelActiveJobs?: boolean }>;
    if (runCommand[2] === "pause") return json("command-result", pauseRunCommand(context.db, { ...body, runId }));
    if (runCommand[2] === "resume") return json("command-result", resumeRunCommand(context.db, { ...body, runId }));
    return json("command-result", cancelRunCommand(context.db, { ...body, runId }));
  }

  const taskCommand = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/(retry|fork-session|rollback-workspace|request-revision)$/);
  if (request.method === "POST" && taskCommand) {
    const runId = decodeURIComponent(taskCommand[1]!);
    const taskId = decodeURIComponent(taskCommand[2]!);
    const body = await request.json() as SouthstarCommandRequest<{ reason?: string; prompt?: string }>;
    const input = { ...body, runId, taskId };
    if (taskCommand[3] === "retry") return json("command-result", retryTaskCommand(context.db, input));
    if (taskCommand[3] === "fork-session") return json("command-result", requestTaskSessionForkCommand(context.db, input));
    if (taskCommand[3] === "rollback-workspace") return json("command-result", rollbackWorkspaceCommand(context.db, input));
    return json("command-result", requestWorkflowRevisionCommand(context.db, input));
  }

  const sessionCommand = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/(fork|reset|rollback|rewind)$/);
  if (request.method === "POST" && sessionCommand) {
    const body = await request.json() as SouthstarCommandRequest<{ checkpointId?: string; reason?: string }>;
    const input = { ...body, sessionId: decodeURIComponent(sessionCommand[1]!) };
    if (sessionCommand[2] === "fork") return json("command-result", forkSessionCommand(context.db, input));
    if (sessionCommand[2] === "reset") return json("command-result", resetSessionCommand(context.db, input));
    if (sessionCommand[2] === "rewind") return json("command-result", rewindSessionCommand(context.db, input));
    return json("command-result", rollbackSessionCommand(context.db, input));
  }

  const memoryCommand = url.pathname.match(/^\/api\/v2\/memory\/([^/]+)\/(approve|reject|do-not-inject)$/);
  if (request.method === "POST" && memoryCommand) {
    const body = await request.json() as SouthstarCommandRequest<{ reason?: string }>;
    const input = { ...body, memoryId: decodeURIComponent(memoryCommand[1]!) };
    if (memoryCommand[2] === "approve") return json("command-result", approveMemoryCommand(context.db, input));
    if (memoryCommand[2] === "reject") return json("command-result", rejectMemoryCommand(context.db, input));
    return json("command-result", doNotInjectMemoryCommand(context.db, input));
  }

  const worktreeCommand = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/worktree\/(snapshots|rollback-preview|rollback)$/);
  if (request.method === "POST" && worktreeCommand) {
    const body = await request.json() as SouthstarCommandRequest<{ repoRoot: string; taskId?: string; snapshotRef?: string; previewId?: string }>;
    const input = { ...body, runId: decodeURIComponent(worktreeCommand[1]!) };
    if (worktreeCommand[2] === "snapshots") return json("command-result", createWorktreeSnapshotCommand(context.db, input));
    if (worktreeCommand[2] === "rollback-preview") return json("command-result", previewWorktreeRollbackCommand(context.db, input));
    return json("command-result", rollbackWorktreeCommand(context.db, input));
  }

  const executorCommand = url.pathname.match(/^\/api\/v2\/executor\/jobs\/([^/]+)\/(retry|cancel|reconcile)$/);
  if (request.method === "POST" && executorCommand) {
    const body = await request.json() as SouthstarCommandRequest<{ reason?: string }>;
    const input = { ...body, jobId: decodeURIComponent(executorCommand[1]!) };
    if (executorCommand[2] === "retry") return json("command-result", retryExecutorJobCommand(context.db, input));
    if (executorCommand[2] === "cancel") return json("command-result", cancelExecutorJobCommand(context.db, input));
    return json("command-result", reconcileExecutorJobCommand(context.db, input));
  }

  const domainCommand = url.pathname.match(/^\/api\/v2\/domain-packs\/([^/]+)\/(validate|preview-workflow|publish)$/);
  if (request.method === "POST" && domainCommand) {
    const body = await request.json() as SouthstarCommandRequest<{ goalPrompt?: string; version?: string }>;
    const input = { ...body, domainPackId: decodeURIComponent(domainCommand[1]!) };
    if (domainCommand[2] === "validate") return json("command-result", validateDomainPackCommand(context.db, input));
    if (domainCommand[2] === "preview-workflow") return json("command-result", previewDomainPackWorkflowCommand(context.db, input));
    return json("command-result", publishDomainPackCommand(context.db, input));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/mcp") return json("command-result", addMcpConnectionCommand(context.db, await request.json() as SouthstarCommandRequest<{ name?: string; scope?: string }>));
  if (request.method === "POST" && url.pathname === "/api/v2/vault/secret-groups") return json("command-result", addVaultSecretGroupCommand(context.db, await request.json() as SouthstarCommandRequest<{ name?: string; scopedAccess?: string }>));
  if (request.method === "POST" && url.pathname === "/api/v2/approval-policy/simulate") return json("command-result", simulateApprovalPolicyCommand(context.db, await request.json() as SouthstarCommandRequest<{ actionType?: string; riskTags?: string[] }>));
  const approvalDecision = url.pathname.match(/^\/api\/v2\/approvals\/([^/]+)\/decision$/);
  if (request.method === "POST" && approvalDecision) return json("command-result", decideApprovalCommand(context.db, { ...(await request.json() as SouthstarCommandRequest<{ decision?: "approved" | "rejected"; reason?: string }>), approvalId: decodeURIComponent(approvalDecision[1]!) }));

  const pauseMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/pause$/);
  if (request.method === "POST" && pauseMatch) {
    const body = await request.json() as SouthstarCommandRequest;
    return json("command-result", rejectedCommand(body.commandId, "Select an existing run before pausing."));
  }
  return undefined;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
