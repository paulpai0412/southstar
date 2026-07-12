import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHashForPayload } from "../../../src/v2/design-library/canonical-json.ts";
import { syncLibraryFileToGraph } from "../../../src/v2/design-library/files/library-file-store.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import { goalContractHash, storedGoalContract } from "../../../src/v2/orchestration/goal-contract.ts";
import { storedGoalRequirementCoverage } from "../../../src/v2/orchestration/goal-requirement-coverage.ts";
import { loadRunLibrarySnapshotPg } from "../../../src/v2/orchestration/run-library-snapshot.ts";
import { getResourceByKeyPg, listHistoryForRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  startIsolatedRealTork,
  waitForPostgresRunStatus,
  waitForTorkJob,
} from "../postgres-real-harness.ts";
import {
  createRealRecoveryScheduler,
  latestHandExecutionForTask,
  waitForHandExecutionStatus,
} from "../recovery-scheduler-helpers.ts";

const GOAL = "Deliver a production-ready local membership subscription module in the workspace, with access control, billing state, immediate cancellation, idempotent full-refund records, and audit reporting; use only the local payment ledger in the repository and do not deploy or charge external accounts";
const TARGET_PROJECT_CWD = process.env.SOUTHSTAR_CASE31_PROJECT_CWD ?? join(homedir(), "apps", "southstar-vocab");
const MEMBERSHIP_MODULE_PATH = "src/membership.mjs";
const MEMBERSHIP_TEST_PATH = "tests/membership-subscription.test.mjs";
const FORBIDDEN_INGRESS = new Set([
  "/api/v2/planner/drafts",
  "/api/v2/planner/drafts/validate",
  "/api/v2/runs",
  "/api/v2/execute",
]);

type RunGoalResult = {
  goalContractHash: string;
  draftId: string;
  draftStatus: string;
  runId?: string;
  runStatus?: string;
  approvalId?: string;
  blockers: string[];
};

test("31 one prompt goal contract: membership software goal completes with frozen evidence", { timeout: 40 * 60 * 1000 }, async () => {
  const checkpoint = (message: string) => console.info(`[case31] ${message}`);
  const env = await createInitializedRealPostgresE2E();
  const materializationRoot = await mkdtemp("/tmp/case31-materialization-");
  const workspace = TARGET_PROJECT_CWD;
  let isolatedTork: Awaited<ReturnType<typeof startIsolatedRealTork>> | undefined;
  let server: Awaited<ReturnType<typeof createRealRuntimeServer>> | undefined;
  const requests: Array<{ method: string; path: string }> = [];

  try {
    await prepareMembershipAcceptanceWorkspace(workspace);
    isolatedTork = await startIsolatedRealTork({
      postgresAdminUrl: env.adminUrl,
      materializationRoot,
      workspace,
      piPlannerEndpoint: process.env.PI_PLANNER_ENDPOINT,
      piHarnessEndpoint: process.env.PI_HARNESS_ENDPOINT,
      callbackHost: process.env.SOUTHSTAR_CALLBACK_HOST,
    });
    const infra = isolatedTork.infra;
    await probeRealPostgresTorkPi(infra);
    await syncCase31LibraryGraph(env.db);
    server = await createRealRuntimeServer({ db: env.db, infra });

    const result = await api<RunGoalResult>(server.port, "/api/v2/run-goal", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({
        goalPrompt: GOAL,
        cwd: workspace,
        idempotencyKey: `case31-${Date.now()}`,
        goalDesignMode: "auto_until_blocked",
      }),
    }, requests);
    if (result.draftStatus !== "validated") {
      const invalidDraft = await getResourceByKeyPg(env.db, "planner_draft", result.draftId);
      const payload = invalidDraft?.payload as Record<string, unknown> | undefined;
      const summary = invalidDraft?.summary as Record<string, unknown> | undefined;
      throw new Error(`Case31 planner draft ${result.draftStatus}: ${JSON.stringify({
        draftId: result.draftId,
        persistedDraftFound: Boolean(invalidDraft),
        blockers: result.blockers,
        summaryStatus: summary?.status,
        summaryValidationIssues: summary?.validationIssues,
        payloadKeys: payload ? Object.keys(payload).sort() : [],
        repairAttempts: payload?.repairAttempts,
        validation: (payload?.orchestrationSnapshot as Record<string, unknown> | undefined)?.validation,
      })}`);
    }
    assert.equal(result.runStatus, "scheduling");
    assert.deepEqual(result.blockers, []);
    assert.ok(result.runId);
    assert.ok(result.approvalId);
    const runId = result.runId;
    checkpoint(`runId=${runId}`);

    const approval = await getResourceByKeyPg(env.db, "approval", result.approvalId);
    assert.equal(approval?.status, "approved");
    assert.equal((approval?.payload as Record<string, unknown>).decisionMode, "auto");
    assert.equal((approval?.payload as Record<string, unknown>).policyReason, "policy low-risk auto approval");

    const draft = await getResourceByKeyPg(env.db, "planner_draft", result.draftId);
    assert.ok(draft);
    const draftPayload = draft.payload as Record<string, unknown>;
    const contract = storedGoalContract(draftPayload.goalContract);
    assert.ok(contract);
    assert.equal(contract.originalPrompt, GOAL);
    assert.equal(contract.domain, "software");
    assert.equal(goalContractHash(contract), result.goalContractHash);
    assert.equal(contract.requirements.filter((requirement) => requirement.blocking).length >= 4, true);
    const workflowWords = new Set(["plan", "implement", "verify", "review"]);
    assert.equal(contract.requirements.some((requirement) => workflowWords.has(requirement.statement.trim().toLowerCase())), false);

    const coverage = storedGoalRequirementCoverage(draftPayload.goalRequirementCoverage);
    assert.ok(coverage);
    assert.equal(coverage.goalContractHash, result.goalContractHash);
    assert.deepEqual(
      new Set(coverage.entries.map((entry) => entry.requirementId)),
      new Set(contract.requirements.map((requirement) => requirement.id)),
    );
    assert.equal(coverage.entries.every((entry) => entry.producerTaskIds.length > 0 && entry.evaluatorTaskIds.length > 0), true);

    const run = await env.db.one<{
      status: string;
      workflow_manifest_json: SouthstarWorkflowManifest;
      runtime_context_json: Record<string, unknown>;
    }>("select status, workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(run.status, "scheduling");
    assert.equal(run.runtime_context_json.goalContractHash, result.goalContractHash);
    assert.equal(run.runtime_context_json.manifestHash, contentHashForPayload(run.workflow_manifest_json));
    assertCoverageBackedDag(run.workflow_manifest_json, coverage);

    const frozenSnapshot = await loadRunLibrarySnapshotPg(env.db, runId);
    assert.equal(frozenSnapshot.goalContractHash, result.goalContractHash);
    assert.equal(frozenSnapshot.manifestHash, run.runtime_context_json.manifestHash);
    assert.equal(frozenSnapshot.snapshotHash, run.runtime_context_json.librarySnapshotHash);
    checkpoint(`contractHash=${result.goalContractHash} manifestHash=${frozenSnapshot.manifestHash} snapshotHash=${frozenSnapshot.snapshotHash}`);

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
      runRoot: materializationRoot,
    });
    const torkJobIds: string[] = [];
    const dispatched = new Set<string>();
    for (let wave = 1; wave <= run.workflow_manifest_json.tasks.length + 1; wave += 1) {
      const status = await env.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
      if (status.status === "completed") break;
      const dispatch = await scheduler.runOnce({ runId });
      if (dispatch.dispatchedTaskIds.length === 0) {
        throw new Error(`case31 scheduler made no progress at wave ${wave}: ${JSON.stringify(dispatch.skippedTaskIds)}`);
      }
      checkpoint(`wave=${wave} dispatched=${dispatch.dispatchedTaskIds.join(",")}`);
      await Promise.all(dispatch.dispatchedTaskIds.map(async (taskId) => {
        assert.equal(dispatched.has(taskId), false);
        dispatched.add(taskId);
        const hand = await latestHandExecutionForTask(env.db, { runId, taskId });
        torkJobIds.push(hand.externalJobId);
        await waitForTorkJob(infra.torkBaseUrl, hand.externalJobId);
        await assertHandCompleted(env.db, hand.resourceKey, { runId, taskId, workspace });
      }));
    }

    assert.equal(await waitForPostgresRunStatus(env.db, runId, ["completed", "failed"]), "completed");
    assert.equal(dispatched.size, run.workflow_manifest_json.tasks.length);
    const taskRows = await env.db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order, id",
      [runId],
    );
    assert.equal(taskRows.rows.every((task) => task.status === "completed"), true);

    const history = await listHistoryForRunPg(env.db, runId);
    assertDependencyDispatchHistory(run.workflow_manifest_json, history);
    const evaluatorRows = await env.db.query<{ resource_key: string; status: string; payload_json: Record<string, unknown> }>(
      `select resource_key, status, payload_json
         from southstar.runtime_resources
        where run_id = $1 and resource_type = 'requirement_evaluator_result'
        order by resource_key`,
      [runId],
    );
    for (const requirement of contract.requirements.filter((candidate) => candidate.blocking)) {
      assert.equal(evaluatorRows.rows.some((row) =>
        row.status === "passed"
        && row.payload_json.verdict === "passed"
        && Array.isArray(row.payload_json.requirementIds)
        && row.payload_json.requirementIds.includes(requirement.id)
      ), true, `missing passed evaluator result for ${requirement.id}`);
    }
    const outcome = await getResourceByKeyPg(env.db, "goal_outcome", `goal-outcome:${runId}`);
    assert.equal(outcome?.status, "satisfied");
    assert.equal((outcome?.payload as Record<string, unknown>).schemaVersion, "southstar.goal_outcome.v1");

    assert.deepEqual(await loadRunLibrarySnapshotPg(env.db, runId), frozenSnapshot);
    assert.deepEqual(requests, [{ method: "POST", path: "/api/v2/run-goal" }]);
    assert.equal(requests.some((request) => FORBIDDEN_INGRESS.has(request.path)), false);
    assert.equal(run.workflow_manifest_json.tasks.some((task) =>
      [...task.toolGrantRefs ?? [], ...task.vaultLeasePolicyRefs ?? []].some((ref) => /deploy|production|secret|vault|real.payment/i.test(ref))
    ), false);

    const evidenceIds = evaluatorRows.rows.flatMap((row) =>
      Array.isArray(row.payload_json.evidenceRefs) ? row.payload_json.evidenceRefs.filter((value): value is string => typeof value === "string") : []
    );
    const workspaceFiles = await listWorkspaceFiles(workspace);
    checkpoint(`evidenceIds=${evidenceIds.join(",")}`);
    checkpoint(`torkJobIds=${torkJobIds.join(",")}`);
    checkpoint(`workspace=${workspace} files=${workspaceFiles.join(",")}`);
    assert.equal(torkJobIds.length, run.workflow_manifest_json.tasks.length);
    assert.equal(evidenceIds.length >= contract.requirements.filter((requirement) => requirement.blocking).length, true);
    assert.equal(workspaceFiles.includes(MEMBERSHIP_MODULE_PATH), true);
    execFileSync("node", ["--test", MEMBERSHIP_TEST_PATH], { cwd: workspace, stdio: "pipe" });
  } finally {
    await server?.close();
    await isolatedTork?.close();
    await env.close();
    await rm(materializationRoot, { recursive: true, force: true });
  }
});

async function prepareMembershipAcceptanceWorkspace(cwd: string): Promise<void> {
  await mkdir(join(cwd, "tests"), { recursive: true });
  await writeFile(join(cwd, MEMBERSHIP_TEST_PATH), `
import assert from "node:assert/strict";
import test from "node:test";
import { LocalPaymentLedger, MembershipService } from "../src/membership.mjs";

test("membership subscription lifecycle is persisted, access-controlled, refundable, and auditable", () => {
  const ledger = new LocalPaymentLedger();
  const service = new MembershipService({ ledger });

  assert.equal(service.canAccess("account-a", "premium-course"), false);
  const subscription = service.subscribe({ accountId: "account-a", planId: "pro", amountCents: 1200 });
  assert.equal(subscription.status, "active");
  assert.equal(service.canAccess("account-a", "premium-course"), true);

  const cancellation = service.cancel({ accountId: "account-a", reason: "user-request" });
  assert.equal(cancellation.status, "cancelled");
  assert.equal(cancellation.refund.amountCents, 1200);
  assert.equal(service.canAccess("account-a", "premium-course"), false);

  const secondCancellation = service.cancel({ accountId: "account-a", reason: "user-request" });
  assert.equal(secondCancellation.refund.id, cancellation.refund.id);
  assert.equal(ledger.refunds().length, 1);
  assert.deepEqual(service.auditReport().map((event) => event.type), ["charge", "subscription_activated", "refund", "subscription_cancelled"]);
});
`);
}

async function syncCase31LibraryGraph(db: Parameters<typeof syncLibraryFileToGraph>[0]): Promise<void> {
  const root = join(import.meta.dirname, "../../../library");
  for (const relativePath of [
    "domains/software.domain.yaml",
    "capabilities/repo-read.capability.yaml",
    "capabilities/repo-write.capability.yaml",
    "capabilities/test-execution.capability.yaml",
    "artifacts/implementation-report.artifact.yaml",
    "artifacts/verification-report.artifact.yaml",
    "artifacts/completion-report.artifact.yaml",
    "tools/workspace-read.tool.yaml",
    "tools/workspace-write.tool.yaml",
    "tools/test-runner.tool.yaml",
    "mcp/filesystem-workspace.mcp.yaml",
    "skills/software-delivery.skill.md",
    "skills/southstar-goal-design.skill.md",
    "skills/southstar-slice-to-dag-composer.skill.md",
    "agents/software-delivery-engineer.agent.md",
    "evaluators/software-quality.evaluator.yaml",
  ]) {
    await syncLibraryFileToGraph(db, { root, relativePath });
  }
}

async function assertHandCompleted(
  db: Parameters<typeof getResourceByKeyPg>[0],
  resourceKey: string,
  input: { runId: string; taskId: string; workspace: string },
): Promise<void> {
  const status = await waitForHandExecutionStatus(db, resourceKey, ["completed", "failed"]);
  if (status === "completed") return;
  const hand = await getResourceByKeyPg(db, "hand_execution", resourceKey);
  const task = await db.maybeOne<{ status: string; snapshot_json: Record<string, unknown> }>(
    "select status, snapshot_json from southstar.workflow_tasks where run_id = $1 and id = $2",
    [input.runId, input.taskId],
  );
  const resources = await db.query<{ resource_type: string; resource_key: string; status: string; summary_json: Record<string, unknown>; payload_json: Record<string, unknown> }>(
    `select resource_type, resource_key, status, summary_json, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
      order by created_at, resource_type, resource_key`,
    [input.runId, input.taskId],
  );
  throw new Error(`case31 hand failed: ${JSON.stringify({
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    handStatus: hand?.status,
    handPayload: hand?.payload,
    task,
    workspaceFiles: await listWorkspaceFiles(input.workspace),
    npmTest: runNpmTestDiagnostic(input.workspace),
    resources: resources.rows.map(compactRuntimeResourceForDiagnostic),
  }, null, 2)}`);
}

function compactRuntimeResourceForDiagnostic(row: {
  resource_type: string;
  resource_key: string;
  status: string;
  summary_json: Record<string, unknown>;
  payload_json: Record<string, unknown>;
}): Record<string, unknown> {
  const payload = row.payload_json ?? {};
  return {
    type: row.resource_type,
    key: row.resource_key,
    status: row.status,
    summary: row.summary_json,
    payloadKeys: Object.keys(payload).sort(),
    verdict: payload.verdict,
    messages: Array.isArray(payload.messages) ? payload.messages.slice(0, 5) : undefined,
    completeness: payload.completeness,
    evidenceItems: Array.isArray(payload.evidenceItems)
      ? payload.evidenceItems.map((item) => isRecord(item)
        ? {
          kind: item.kind,
          status: item.status,
          sourceRef: item.sourceRef,
          summary: typeof item.summary === "string" ? item.summary.slice(0, 500) : item.summary,
        }
        : item).slice(0, 8)
      : undefined,
    findings: Array.isArray(payload.findings) ? payload.findings.slice(0, 8) : undefined,
    lastError: typeof payload.lastError === "string" ? payload.lastError.slice(-2_000) : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runNpmTestDiagnostic(cwd: string): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync("node", ["--test", MEMBERSHIP_TEST_PATH], { cwd, encoding: "utf8", stdio: "pipe" }).slice(-8_000),
    };
  } catch (error) {
    const execError = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      output: `${String(execError.stdout ?? "")}\n${String(execError.stderr ?? "")}\n${execError.message ?? String(error)}`.slice(-8_000),
    };
  }
}

function assertCoverageBackedDag(
  manifest: SouthstarWorkflowManifest,
  coverage: NonNullable<ReturnType<typeof storedGoalRequirementCoverage>>,
): void {
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  for (const entry of coverage.entries) {
    assert.equal(entry.producerTaskIds.length > 0, true, `coverage entry ${entry.requirementId} missing producer tasks`);
    assert.equal(entry.evaluatorTaskIds.length > 0, true, `coverage entry ${entry.requirementId} missing evaluator tasks`);
    for (const taskId of [...entry.producerTaskIds, ...entry.evaluatorTaskIds]) {
      assert.ok(tasks.has(taskId), `coverage entry ${entry.requirementId} references missing task ${taskId}`);
    }
    for (const producerTaskId of entry.producerTaskIds) {
      assert.equal(entry.evaluatorTaskIds.some((evaluatorTaskId) =>
        evaluatorTaskId === producerTaskId || ancestors(tasks, evaluatorTaskId).has(producerTaskId)
      ), true, `coverage evaluator for ${entry.requirementId} cannot see producer ${producerTaskId}`);
    }
  }
}

function ancestors(tasks: Map<string, SouthstarWorkflowManifest["tasks"][number]>, taskId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of tasks.get(id)?.dependsOn ?? []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      visit(dependency);
    }
  };
  visit(taskId);
  return found;
}

function assertDependencyDispatchHistory(
  manifest: SouthstarWorkflowManifest,
  history: Awaited<ReturnType<typeof listHistoryForRunPg>>,
): void {
  const dispatchSequence = new Map(history.filter((event) => event.eventType === "task.dispatch_submitted")
    .map((event) => [event.taskId, event.sequence]));
  const acceptedSequence = new Map(history.filter((event) =>
    event.eventType === "artifact.created" && (event.payload as Record<string, unknown>).accepted === true
  ).map((event) => [event.taskId, event.sequence]));
  for (const task of manifest.tasks) {
    const dispatchedAt = dispatchSequence.get(task.id);
    assert.ok(dispatchedAt, `missing dispatch history for ${task.id}`);
    for (const dependency of task.dependsOn) {
      const acceptedAt = acceptedSequence.get(dependency);
      assert.ok(acceptedAt, `missing accepted artifact history for dependency ${dependency}`);
      assert.equal(acceptedAt < dispatchedAt, true, `${task.id} dispatched before ${dependency} artifact acceptance`);
    }
  }
}

async function listWorkspaceFiles(root: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".southstar-runs") continue;
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...await listWorkspaceFiles(root, relative));
    else paths.push(relative);
  }
  return paths.sort();
}

async function api<T>(
  port: number,
  path: string,
  init: RequestInit,
  requests: Array<{ method: string; path: string }>,
): Promise<T> {
  requests.push({ method: init.method ?? "GET", path });
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const frames = text.split("\n\n").map((frame) => frame.split("\n"));
    const errorFrame = frames.find((lines) => lines.includes("event: error"));
    const streamError = errorFrame?.find((line) => line.startsWith("data: "))?.slice(6);
    if (streamError) throw new Error(`${init.method ?? "GET"} ${path} stream failed: ${streamError}`);
    const done = frames.find((lines) => lines.includes("event: done"));
    const data = done?.find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) throw new Error(`${init.method ?? "GET"} ${path} stream ended without done`);
    return JSON.parse(data) as T;
  }
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}
