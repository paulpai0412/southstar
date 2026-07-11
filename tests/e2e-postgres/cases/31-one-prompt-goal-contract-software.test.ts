import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { contentHashForPayload } from "../../../src/v2/design-library/canonical-json.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import { goalContractHash, storedGoalContract } from "../../../src/v2/orchestration/goal-contract.ts";
import { storedGoalRequirementCoverage } from "../../../src/v2/orchestration/goal-requirement-coverage.ts";
import { loadRunLibrarySnapshotPg } from "../../../src/v2/orchestration/run-library-snapshot.ts";
import { getResourceByKeyPg, listHistoryForRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { seedSoftwareLibraryGraph } from "../../v2/fixtures/software-library-graph.ts";
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

const GOAL = "Deliver a production-ready membership subscription flow in the local test workspace using the provided fake payment adapter, with access control, billing state, cancellation/refund behavior, and audit reporting; do not deploy or charge real accounts";
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
  const workspace = await mkdtemp("/tmp/case31-workspace-");
  let isolatedTork: Awaited<ReturnType<typeof startIsolatedRealTork>> | undefined;
  let server: Awaited<ReturnType<typeof createRealRuntimeServer>> | undefined;
  const requests: Array<{ method: string; path: string }> = [];

  try {
    await createLocalMembershipWorkspace(workspace);
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
    await seedSoftwareLibraryGraph(env.db);
    server = await createRealRuntimeServer({ db: env.db, infra });

    const result = await api<RunGoalResult>(server.port, "/api/v2/run-goal", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({ goalPrompt: GOAL, cwd: workspace, idempotencyKey: `case31-${Date.now()}` }),
    }, requests);
    if (result.draftStatus !== "validated") {
      const invalidDraft = await getResourceByKeyPg(env.db, "planner_draft", result.draftId);
      const payload = invalidDraft?.payload as Record<string, unknown> | undefined;
      throw new Error(`Case31 planner draft ${result.draftStatus}: ${JSON.stringify({
        blockers: result.blockers,
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
    assertCompoundTopology(run.workflow_manifest_json, coverage);

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
        assert.equal(await waitForHandExecutionStatus(env.db, hand.resourceKey, ["completed", "failed"]), "completed");
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
    assert.equal(workspaceFiles.includes("fake-payment-adapter.mjs"), true);
    assert.match(await readFile(join(workspace, "fake-payment-adapter.mjs"), "utf8"), /fake-payment-adapter\.local-test\.v1/);
  } finally {
    await server?.close();
    await isolatedTork?.close();
    await env.close();
    await rm(materializationRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createLocalMembershipWorkspace(cwd: string): Promise<void> {
  await writeFile(join(cwd, "package.json"), JSON.stringify({
    name: "case31-local-membership",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2));
  await writeFile(join(cwd, "fake-payment-adapter.mjs"), `
export const adapterId = "fake-payment-adapter.local-test.v1";

export class FakePaymentAdapter {
  #events = [];
  charge({ accountId, amountCents }) {
    if (!accountId.startsWith("test_")) throw new Error("fake adapter refuses non-test accounts");
    const event = { id: \`fake_charge_\${this.#events.length + 1}\`, type: "charge", accountId, amountCents };
    this.#events.push(event);
    return structuredClone(event);
  }
  refund(chargeId) {
    if (!chargeId.startsWith("fake_charge_")) throw new Error("fake adapter only refunds fake charges");
    const event = { id: \`fake_refund_\${this.#events.length + 1}\`, type: "refund", chargeId };
    this.#events.push(event);
    return structuredClone(event);
  }
  auditEvents() { return structuredClone(this.#events); }
}
`);
  await writeFile(join(cwd, "fake-payment-adapter.test.mjs"), `
import assert from "node:assert/strict";
import test from "node:test";
import { FakePaymentAdapter, adapterId } from "./fake-payment-adapter.mjs";

test("adapter is local, fake, and auditable", () => {
  assert.equal(adapterId, "fake-payment-adapter.local-test.v1");
  const adapter = new FakePaymentAdapter();
  const charge = adapter.charge({ accountId: "test_member_1", amountCents: 1200 });
  assert.match(charge.id, /^fake_charge_/);
  assert.match(adapter.refund(charge.id).id, /^fake_refund_/);
  assert.equal(adapter.auditEvents().length, 2);
  assert.throws(() => adapter.charge({ accountId: "acct_real", amountCents: 1200 }), /non-test/);
});
`);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "case31@southstar.test"], { cwd });
  execFileSync("git", ["config", "user.name", "Southstar Case31"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "test: seed local fake payment workspace"], { cwd });
}

function assertCompoundTopology(
  manifest: SouthstarWorkflowManifest,
  coverage: NonNullable<ReturnType<typeof storedGoalRequirementCoverage>>,
): void {
  const tasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const producers = [...new Set(coverage.entries.flatMap((entry) => entry.producerTaskIds))];
  const evaluators = new Set(coverage.entries.flatMap((entry) => entry.evaluatorTaskIds));
  const independentPair = producers.flatMap((left, index) => producers.slice(index + 1).map((right) => [left, right] as const))
    .find(([left, right]) => !ancestors(tasks, left).has(right) && !ancestors(tasks, right).has(left));
  assert.ok(independentPair, "expected at least two dependency-independent producer branches");
  const [left, right] = independentPair;
  const downstream = manifest.tasks.filter((task) => {
    const taskAncestors = ancestors(tasks, task.id);
    return taskAncestors.has(left) && taskAncestors.has(right);
  });
  assert.equal(downstream.length > 0, true, "expected a downstream integration wave");
  assert.equal(downstream.some((task) => evaluators.has(task.id) || manifest.tasks.some((candidate) =>
    evaluators.has(candidate.id) && ancestors(tasks, candidate.id).has(task.id)
  )), true, "expected a downstream evaluator wave");
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
