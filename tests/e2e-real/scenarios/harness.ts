import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { openSouthstarDb, type SouthstarDb } from "../../../src/v2/stores/sqlite.ts";
import { createHttpPiPlannerClient, createPiSdkPlannerClient } from "../../../src/v2/planner/pi-planner.ts";
import { TorkClient } from "../../../src/v2/executor/tork-client.ts";
import { ingestTaskRunResult, type TaskRunCallbackResult } from "../../../src/v2/executor/tork-callback.ts";
import { getWorkflowRun } from "../../../src/v2/stores/run-store.ts";
import type { AgentHarness, HarnessRunResult } from "../../../src/v2/harness/types.ts";
import { createPiSdkAgentHarness } from "../../../src/v2/harness/pi-sdk-harness.ts";
import type { RealE2EEnv } from "../env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "../fixtures/software-change");

export type RealScenarioContext = {
  env: RealE2EEnv;
  db: SouthstarDb;
  plannerClient: ReturnType<typeof createHttpPiPlannerClient>;
  torkClient: TorkClient;
};

export type CallbackServer = {
  url: string;
  contextRefreshUrl: string;
  close(): Promise<void>;
};

export function createScenarioContext(env: RealE2EEnv): RealScenarioContext {
  return {
    env,
    db: openSouthstarDb(env.southstarDb),
    plannerClient: env.piPlannerEndpoint
      ? createHttpPiPlannerClient({ endpoint: env.piPlannerEndpoint })
      : createPiSdkPlannerClient(),
    torkClient: new TorkClient({ baseUrl: env.torkBaseUrl }),
  };
}

export async function startCallbackServer(env: RealE2EEnv): Promise<CallbackServer> {
  const db = openSouthstarDb(env.southstarDb);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/api/v2/tork/callback") {
        const payload = JSON.parse(await readRequestBody(request)) as TaskRunCallbackResult;
        ingestTaskRunResult(db, payload);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/v2/context/refresh") {
        const payload = JSON.parse(await readRequestBody(request)) as { runId: string; taskId: string };
        const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?")
          .get(payload.runId) as { workflow_manifest_json: string } | undefined;
        const workflow = row ? JSON.parse(row.workflow_manifest_json) as {
          tasks?: Array<{ id: string; dependsOn?: string[] }>;
        } : undefined;
        const task = workflow?.tasks?.find((candidate) => candidate.id === payload.taskId);
        const { buildRefreshedContextSummary } = await import("../../../src/v2/artifacts/context-refresh.ts");
        const upstreamContext = buildRefreshedContextSummary(db, {
          runId: payload.runId,
          taskId: payload.taskId,
          dependencyTaskIds: task?.dependsOn ?? [],
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ upstreamContext }));
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      response.statusCode = 500;
      response.end((error as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("callback server did not bind to a TCP port");
  const callbackHost = process.env.SOUTHSTAR_CALLBACK_HOST ?? "172.17.0.1";
  return {
    url: `http://${callbackHost}:${address.port}/api/v2/tork/callback`,
    contextRefreshUrl: `http://${callbackHost}:${address.port}/api/v2/context/refresh`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function createHttpAgentHarness(env: RealE2EEnv): AgentHarness {
  if (!env.piHarnessEndpoint) return createPiSdkAgentHarness({ timeoutMs: 180_000 });
  const endpoint = env.piHarnessEndpoint;
  return {
    id: "pi-agent-http-harness",
    async run(input): Promise<HarnessRunResult> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Pi harness request failed: ${response.status} ${text}`);
      }
      const payload = JSON.parse(text) as HarnessRunResult;
      if (!payload.artifact || !Array.isArray(payload.progress)) {
        throw new Error("Pi harness response must include artifact and progress");
      }
      return payload;
    },
  };
}

export function prepareSoftwareFixtureRepo(env: RealE2EEnv, name: string): string {
  const repo = join(env.workspaceRoot, name);
  removeFixtureRepo(repo);
  mkdirSync(dirname(repo), { recursive: true });
  cpSync(fixtureRoot, repo, { recursive: true });
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "southstar-e2e@example.local"], repo);
  run("git", ["config", "user.name", "Southstar E2E"], repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "initial calc add fixture"], repo);
  run("npm", ["install"], repo);
  return repo;
}

export function softwareGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成一個小型軟工任務：新增 CLI 指令 calc sum <numbers...>。",
    "支援多個數字輸入、負數、小數、無效輸入錯誤訊息；同步更新單元測試與 README 用法。",
    "Southstar 必須自動判斷 domain/intent，依 software domain pack 動態產生 workflow DAG，不可固定四個 task。",
    "每個 task 必須解析 role、agent profile、model、skills、MCP grants、memory scope，並在 agent 執行前保存可追蹤 ContextPacket。",
    "任務必須透過 Docker/Tork 執行；Tork 只能是 executor，不能保存 workflow truth。",
    "產出 artifact 後必須由 evaluator pipeline 與 stop condition 驗收；若驗收失敗，RootSession 必須記錄 retry 或 fork/rollback/workflow revision recovery decision。",
    "最後只有 stop condition 通過，run 才能標記 passed/completed。",
    "artifact 必須包含修改摘要、filesChanged、commandsRun、testResults、risks、artifactEvidence。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export function artifactEvidenceValidatorGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成可驗證的軟工任務：新增 CLI 指令 calc sum <numbers...>。",
    "這不是 smoke test；必須透過真實 Docker/Tork 執行每個 workflow task，並產出可驗收 artifact/evidence/validator resources。",
    "功能要求：支援多個數字、負數、小數；invalid input 必須非 0 exit code 並顯示 Invalid number: <value>。",
    "品質要求：更新單元測試與 README；不新增 runtime dependency；保持最小改動。",
    "Artifact 要求：每個 task 必須產出 contract-valid artifact；implementation artifact 必須包含 summary、filesChanged、commandsRun、testResults、risks、artifactEvidence。",
    "Evidence 要求：每個 accepted artifact 必須有 evidence_packet；implementation 必須有 file-diff、test-result、command-output evidence。",
    "Validator 要求：每個 accepted artifact 必須有 typed validator_result；blocking validator 不可 failed。",
    "Context 要求：downstream task 不可依賴 raw transcript 或盲目掃 workspace；必須使用 accepted upstream artifact/evidence summary。",
    "量化驗收：run 必須 passed/completed；accepted artifact count 必須等於 evidence packet count；blocking validator failures 必須為 0；fixture repo 必須通過 npm test。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export function phase15OperationsGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成 Southstar Phase 1.5 operations workflow 測試：新增 CLI 指令 calc sum <numbers...>。",
    "支援多數字輸入、負數、小數、無效輸入錯誤訊息、測試、README 用法，並產出 implementation artifact。",
    "Southstar 必須自動判斷 domain/intent，依 software domain pack 動態產生 workflow DAG，不可固定四個 task。",
    "每個 task 必須解析 role、agent profile、model、skills、MCP grants、memory scope，並在 agent 執行前保存可追蹤 ContextPacket。",
    "task 必須經 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。",
    "artifact 必須經 evaluator pipeline 與 stop condition 驗收，驗收失敗時 RootSession 必須記錄 retry 或 fork/rollback/workflow revision recovery decision。",
    "請使用已核准的 software.calc-cli skill，保持最小改動，不新增 runtime dependency。",
    "執行期間必須輸出 progress commentary，並保存 session、artifact、executor binding、skill snapshot 到 SQLite。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export function uiControlPlaneGoalPrompt(repo: string): string {
  return [
    "在目前 fixture repo 新增 CLI 指令 sum <numbers...>。",
    "要求：",
    "1. 支援整數、負數、小數。",
    "2. invalid input 要回傳非 0 exit code 並顯示 Invalid number: <value>。",
    "3. 補 unit tests，至少涵蓋正數、負數、小數、invalid input。",
    "4. 更新 README，包含正數、負數/小數、invalid input 三種用法。",
    "5. 不新增 runtime dependency。",
    "6. Southstar 必須自動判斷 domain/intent。",
    "7. 必須依 software domain pack 動態產生 workflow DAG，不可固定四個 task。",
    "8. 每個 task 必須解析 role、agent、model、skill、MCP、memory scope。",
    "9. 每個 agent 執行前必須保存可追蹤 ContextPacket，並記錄 memory 為什麼注入或排除。",
    "10. task 必須透過 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。",
    "11. artifact 必須經 evaluator pipeline 驗收；驗收失敗時可 retry、fork session、rollback workspace、或要求 workflow revision。",
    "12. session 必須有 checkpoint/fork/reset/rollback lineage 可查。",
    "13. Git/worktree 必須用於 software workspace snapshot 或 rollback reference。",
    "14. 只有 stop condition 通過，run 才能完成。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export async function waitForTorkJob(baseUrl: string, jobId: string, timeoutMs = 15 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const root = baseUrl.replace(/\/$/, "");
  while (Date.now() < deadline) {
    const response = await fetchTorkJobStatus(root, jobId);
    const payload = await response.json() as { status?: string; state?: string };
    const status = (payload.status ?? payload.state ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "success") return;
    if (status === "failed" || status === "errored" || status === "cancelled") {
      throw new Error(`Tork job ${jobId} ended with ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Tork job ${jobId} did not complete within ${timeoutMs}ms`);
}

async function fetchTorkJobStatus(root: string, jobId: string): Promise<Response> {
  const encodedJobId = encodeURIComponent(jobId);
  const primary = await fetch(`${root}/jobs/${encodedJobId}`);
  if (primary.ok) return primary;
  const fallback = await fetch(`${root}/api/v1/jobs/${encodedJobId}`);
  if (fallback.ok) return fallback;
  throw new Error(`Tork job status failed: ${primary.status} ${await primary.text()}`);
}

export async function waitForRunStatus(db: SouthstarDb, runId: string, statuses: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare("select status from workflow_runs where id = ?").get(runId) as { status: string } | undefined;
    if (row && statuses.includes(row.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join(", ")} within ${timeoutMs}ms`);
}

export function assertCalcSum(repo: string): void {
  const output = run("npm", ["run", "-s", "cli", "--", "sum", "1", "2", "3"], repo);
  assert.match(output.trim(), /^6$/);
  assert.match(run("npm", ["run", "-s", "cli", "--", "sum", "-2", "5", "0.5"], repo).trim(), /^3\.5$/);
  assert.match(run("npm", ["run", "-s", "cli", "--", "sum", "-1", "-2.5"], repo).trim(), /^-3\.5$/);
  assertInvalidInput(repo);
  assertReadmeAndTestsDocumentCalcSum(repo);
}

export function assertFixtureTests(repo: string): void {
  execFileSync("docker", [
    "run",
    "--rm",
    "-v",
    `${repo}:/workspace/repo`,
    "-w",
    "/workspace/repo",
    "--entrypoint",
    "npm",
    "southstar/pi-agent:local",
    "test",
  ], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function assertArtifactEvidenceQuantitativeGates(db: SouthstarDb, runId: string): void {
  const completedTasks = count(db, "workflow_tasks", "run_id = ? and status = 'completed'", [runId]);
  assert.equal(completedTasks >= 4, true, `expected at least 4 completed tasks, got ${completedTasks}`);

  const acceptedArtifacts = count(
    db,
    "runtime_resources",
    "run_id = ? and resource_type = 'artifact' and status = 'accepted'",
    [runId],
  );
  assert.equal(
    acceptedArtifacts,
    completedTasks,
    `accepted artifact count ${acceptedArtifacts} must equal completed task count ${completedTasks}`,
  );

  const evidencePackets = count(
    db,
    "runtime_resources",
    "run_id = ? and resource_type = 'evidence_packet' and status = 'complete'",
    [runId],
  );
  assert.equal(
    evidencePackets,
    acceptedArtifacts,
    `complete evidence packets ${evidencePackets} must equal accepted artifacts ${acceptedArtifacts}`,
  );

  const validatorRows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'validator_result'
  `).all(runId) as Array<{ payload_json: string }>;
  const failedBlocking = validatorRows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { blocking?: boolean; verdict?: string };
    return payload.blocking === true && payload.verdict === "failed";
  });
  assert.equal(failedBlocking.length, 0, `blocking validator failures must be 0, got ${failedBlocking.length}`);

  const oversized = db.prepare(`
    select resource_type, resource_key, length(payload_json) as size
    from runtime_resources
    where run_id = ? and resource_type in ('artifact', 'evidence_packet', 'validator_result') and length(payload_json) > 50000
  `).all(runId) as Array<{ resource_type: string; resource_key: string; size: number }>;
  assert.deepEqual(oversized, [], `artifact/evidence/validator payloads exceed 50000 bytes: ${JSON.stringify(oversized)}`);

  const readinessRows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'downstream_readiness'
  `).all(runId) as Array<{ payload_json: string }>;
  for (const row of readinessRows) {
    const payload = JSON.parse(row.payload_json) as { ready?: boolean; blockers?: unknown[] };
    assert.equal(payload.ready, true, `downstream readiness must be true: ${row.payload_json}`);
    assert.equal(payload.blockers?.length ?? 0, 0, `downstream readiness blockers must be empty: ${row.payload_json}`);
  }

  const stop = db.prepare(`
    select status from runtime_resources
    where run_id = ? and resource_type = 'stop_condition_result'
    order by created_at desc limit 1
  `).get(runId) as { status: string } | undefined;
  assert.equal(stop?.status, "passed", "terminal stop condition must pass");
}

export function assertSqliteEvidence(db: SouthstarDb): void {
  assert.equal(count(db, "workflow_runs", "status in ('passed', 'completed')") > 0, true);
  for (const eventType of [
    "evaluator.completed",
    "repair.requested",
    "workflow.expanded",
    "task.created",
    "memory.item_approved",
    "session.entry",
    "subagent.completed",
  ]) {
    assert.equal(count(db, "workflow_history", "event_type = ?", [eventType]) > 0, true, `missing ${eventType}`);
  }
  assert.equal(count(db, "runtime_resources", "resource_type = 'workflow_revision' and status = 'applied'") > 0, true);
  const metricsRows = db.prepare("select metrics_json from workflow_runs").all() as Array<{ metrics_json: string }>;
  assert.equal(metricsRows.some((row) => {
    const metrics = JSON.parse(row.metrics_json) as { aggregate?: { tokens?: number; costMicrosUsd?: number } };
    return (metrics.aggregate?.tokens ?? 0) > 0 && (metrics.aggregate?.costMicrosUsd ?? 0) >= 0;
  }), true, "missing aggregate token/cost metrics");
}

export function assertNoE2eStaticManifestUsage(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select goal_prompt from workflow_runs where id = ?").get(runId) as { goal_prompt: string } | undefined;
  assert.ok(row?.goal_prompt.includes("Fixture repo:"), "real E2E run must preserve fixture repo prompt");
}

export function assertDomainPackDynamicWorkflowEvidence(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?").get(runId) as {
    workflow_manifest_json: string;
  } | undefined;
  assert.ok(row, `missing workflow run ${runId}`);
  const workflow = JSON.parse(row.workflow_manifest_json) as {
    domain?: string;
    intent?: string;
    workflowGeneration?: { planId?: string; orchestrationSnapshotId?: string };
    tasks?: Array<{
      id?: string;
      roleRef?: string;
      agentProfileRef?: string;
      providerRef?: string;
      model?: string;
      skillRefs?: string[];
      memoryScopeRefs?: string[];
      mcpGrantRefs?: string[];
      evaluatorPipelineRef?: string;
      contextPolicyRef?: string;
      sessionPolicyRef?: string;
      stopConditionRefs?: string[];
      execution?: { engine?: string };
    }>;
  };
  assert.equal(workflow.domain, "software");
  assert.equal(workflow.intent, "implement_feature");
  assert.ok(workflow.workflowGeneration?.planId, "workflow must be generated from domain pack");
  assert.ok(workflow.workflowGeneration?.orchestrationSnapshotId, "workflow must include orchestration snapshot");
  assert.ok((workflow.tasks?.length ?? 0) >= 5, "broad calc sum prompt should generate a dynamic multi-task DAG");
  assert.notDeepEqual(workflow.tasks?.map((task) => task.id), ["planner", "implementer", "root-validator", "summary"]);
  for (const task of workflow.tasks ?? []) {
    assert.equal(typeof task.roleRef, "string", `missing roleRef for ${task.id}`);
    assert.equal(typeof task.agentProfileRef, "string", `missing agentProfileRef for ${task.id}`);
    assert.equal(typeof task.providerRef, "string", `missing providerRef for ${task.id}`);
    assert.equal(typeof task.model, "string", `missing model for ${task.id}`);
    assert.equal(Array.isArray(task.skillRefs), true, `missing skillRefs for ${task.id}`);
    assert.equal(Array.isArray(task.memoryScopeRefs), true, `missing memoryScopeRefs for ${task.id}`);
    assert.equal(Array.isArray(task.mcpGrantRefs), true, `missing mcpGrantRefs for ${task.id}`);
    assert.equal(typeof task.evaluatorPipelineRef, "string", `missing evaluatorPipelineRef for ${task.id}`);
    assert.equal(typeof task.contextPolicyRef, "string", `missing contextPolicyRef for ${task.id}`);
    assert.equal(typeof task.sessionPolicyRef, "string", `missing sessionPolicyRef for ${task.id}`);
    assert.equal(task.execution?.engine, "tork", `task ${task.id} must execute through Tork`);
  }
  const taskCount = workflow.tasks?.length ?? 0;
  assertResourceCount(db, runId, "workflow_generation_plan", 1);
  assertResourceCount(db, runId, "orchestration_snapshot", 1);
  assertResourceCount(db, runId, "context_packet", taskCount);
  assertResourceCount(db, runId, "memory_injection_trace", taskCount);
  assertResourceCount(db, runId, "session_node", taskCount);
  assertResourceCount(db, runId, "session_checkpoint", taskCount);
  assertResourceCount(db, runId, "workspace_snapshot", 1);
  assertResourceCount(db, runId, "evaluator_pipeline_result", 1);
  assertResourceCount(db, runId, "stop_condition_result", 1);
  if (hasFailedEvaluatorPipeline(db, runId)) {
    assertResourceCount(db, runId, "recovery_decision", 1);
  }

  const stop = db.prepare(`
    select status
    from runtime_resources
    where run_id = ? and resource_type = 'stop_condition_result'
    order by created_at desc
    limit 1
  `).get(runId) as { status: string } | undefined;
  assert.equal(stop?.status, "passed");
}

export function assertDynamicWorkflowEvidence(db: SouthstarDb, runId: string): void {
  assertDomainPackDynamicWorkflowEvidence(db, runId);
}

export function assertTorkProjectionIsExecutorOnly(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select execution_projection_json from workflow_runs where id = ?").get(runId) as {
    execution_projection_json: string;
  } | undefined;
  assert.ok(row, `missing workflow run ${runId}`);
  for (const forbidden of [
    "workflowGeneratorPolicies",
    "memoryPolicies",
    "sessionPolicies",
    "contextPolicies",
    "agentProfiles",
    "roles",
    "domainPackRef",
    "workflowGeneration",
  ]) {
    assert.equal(row.execution_projection_json.includes(forbidden), false, `Tork projection leaked ${forbidden}`);
  }
  assert.match(row.execution_projection_json, /southstar-agent-runner/);
}

export function assertPhase15SqliteEvidence(db: SouthstarDb, runId: string): void {
  for (const eventType of [
    "executor.submitted",
    "progress.commentary",
    "evaluator.completed",
    "session.entry",
  ]) {
    assert.equal(count(db, "workflow_history", "run_id = ? and event_type = ?", [runId, eventType]) > 0, true, `missing ${eventType}`);
  }
  assert.equal(
    count(db, "workflow_history", "run_id = ? and event_type = ?", [runId, "subagent.completed"]) >= 2,
    true,
    "missing subagent/root invocation evidence",
  );
  for (const [resourceType, status] of [
    ["artifact", "accepted"],
    ["skill_snapshot", "resolved"],
  ] as const) {
    assert.equal(
      count(db, "runtime_resources", "run_id = ? and resource_type = ? and status = ?", [runId, resourceType, status]) > 0,
      true,
      `missing ${status} ${resourceType}`,
    );
  }
  assert.equal(
    count(
      db,
      "runtime_resources",
      "run_id = ? and resource_type = 'executor_binding' and status in ('submitted', 'queued', 'running', 'PENDING')",
      [runId],
    ) > 0,
    true,
    "missing submitted/queued executor_binding",
  );
}

export function collectPhase15RuntimeTimings(db: SouthstarDb, runId: string): {
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  firstClientEventMs: number;
} {
  return {
    plannerMs: requireDuration(db, runId, "planner.manifest_generated"),
    validationMs: requireDuration(db, runId, "manifest.validated"),
    torkSubmitMs: requireDuration(db, runId, "executor.submitted"),
    firstClientEventMs: requireEventDeltaMs(db, runId, "run.created", "progress.commentary"),
  };
}

export function findForbiddenDurableFolders(projectRoot: string): string[] {
  const forbidden = [
    ".southstar/session",
    ".southstar/sessions",
    ".southstar/memory",
    ".southstar/memories",
    ".southstar/artifact",
    ".southstar/artifacts",
    ".southstar/vault",
    ".southstar/executor",
    ".southstar/skills",
  ];
  return forbidden.filter((path) => existsSync(join(projectRoot, path)));
}

export function assertNoDurableSouthstarFolders(root: string): void {
  const southstarRoot = join(root, ".southstar");
  if (!existsSync(southstarRoot)) return;
  const blockedNames = new Set(["session", "sessions", "memory", "memories", "artifact", "artifacts", "vault", "executor"]);
  const found: string[] = [];
  walk(southstarRoot, (path) => {
    const name = basename(path);
    if (blockedNames.has(name) && statSync(path).isDirectory()) found.push(path);
  });
  assert.deepEqual(found, [], `durable runtime folders are forbidden: ${found.join(", ")}`);
}

export function findImplementerTaskId(db: SouthstarDb, runId: string): string {
  const run = getWorkflowRun(db, runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  const workflow = JSON.parse(run.workflowManifestJson) as {
    tasks?: Array<{ id?: string; name?: string; subagents?: Array<{ id?: string; prompt?: string }> }>;
  };
  const task = workflow.tasks?.find((candidate) => {
    const searchable = [
      candidate.id,
      candidate.name,
      ...(candidate.subagents ?? []).map((subagent) => subagent.id),
    ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
    return /\bimplement(er|ation)?\b/.test(searchable);
  });
  if (!task?.id) throw new Error(`implementer task not found for run: ${runId}`);
  return task.id;
}

type SqlValue = string | number | bigint | Buffer | null;

function count(db: SouthstarDb, table: string, where: string, args: SqlValue[] = []): number {
  const row = db.prepare(`select count(*) as count from ${table} where ${where}`).get(...args) as { count: number };
  return row.count;
}

function assertResourceCount(db: SouthstarDb, runId: string, resourceType: string, minimum: number): void {
  const actual = count(db, "runtime_resources", "run_id = ? and resource_type = ?", [runId, resourceType]);
  assert.equal(actual >= minimum, true, `expected at least ${minimum} ${resourceType}, got ${actual}`);
}

function hasFailedEvaluatorPipeline(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare(`
    select 1
    from runtime_resources
    where run_id = ? and resource_type = 'evaluator_pipeline_result' and status = 'failed'
    limit 1
  `).get(runId);
  return Boolean(row);
}

function requireDuration(db: SouthstarDb, runId: string, eventType: string): number {
  const row = db.prepare(`
    select payload_json
    from workflow_history
    where run_id = ? and event_type = ?
    order by sequence desc
    limit 1
  `).get(runId, eventType) as { payload_json: string } | undefined;
  assert.ok(row, `missing timing event ${eventType}`);
  const payload = JSON.parse(row.payload_json) as { durationMs?: unknown };
  const durationMs = payload.durationMs;
  if (typeof durationMs !== "number") throw new Error(`${eventType} payload.durationMs must be recorded`);
  return durationMs;
}

function requireEventDeltaMs(db: SouthstarDb, runId: string, fromEventType: string, toEventType: string): number {
  const from = firstEventCreatedAt(db, runId, fromEventType);
  const to = firstEventCreatedAt(db, runId, toEventType);
  const deltaMs = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new Error(`${fromEventType}->${toEventType} timing must be recorded`);
  }
  return deltaMs;
}

function firstEventCreatedAt(db: SouthstarDb, runId: string, eventType: string): string {
  const row = db.prepare(`
    select created_at
    from workflow_history
    where run_id = ? and event_type = ?
    order by sequence asc
    limit 1
  `).get(runId, eventType) as { created_at: string } | undefined;
  assert.ok(row, `missing timing event ${eventType}`);
  return row.created_at;
}

function assertInvalidInput(repo: string): void {
  try {
    run("npm", ["run", "-s", "cli", "--", "sum", "1", "not-a-number"], repo);
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    assert.match(output, /invalid|number|Usage/i);
    return;
  }
  throw new Error("calc sum invalid input must fail");
}

function assertReadmeAndTestsDocumentCalcSum(repo: string): void {
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  assert.match(readme, /\bsum\b/i);
  assert.match(readme, /negative|負數|-\d+(?:\.\d+)?/i);
  assert.match(readme, /decimal|小數|\d+\.\d+/i);
  assert.match(readme, /invalid|not-a-number|NaN|nope|oops|error/i);
  const testSource = readTestSources(join(repo, "test"));
  assert.match(testSource, /sum/i);
}

function readTestSources(testRoot: string): string {
  const sources: string[] = [];
  walk(testRoot, (path) => {
    if (statSync(path).isFile() && /\.test\.ts$/.test(path)) {
      sources.push(readFileSync(path, "utf8"));
    }
  });
  assert.ok(sources.length > 0, "fixture must include at least one .test.ts file");
  return sources.join("\n");
}

function walk(root: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    visit(path);
    if (statSync(path).isDirectory()) walk(path, visit);
  }
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeFixtureRepo(repo: string): void {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    if (!existsSync(repo)) return;
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    execFileSync("docker", [
      "run",
      "--rm",
      "-v",
      `${repo}:/target`,
      "--entrypoint",
      "chown",
      "southstar/pi-agent:local",
      "-R",
      `${uid}:${gid}`,
      "/target",
    ], { stdio: "pipe" });
    rmSync(repo, { recursive: true, force: true });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
