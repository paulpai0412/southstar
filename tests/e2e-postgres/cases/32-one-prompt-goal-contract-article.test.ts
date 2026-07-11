import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { upsertLibraryObject } from "../../../src/v2/design-library/library-graph-store.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import { storedGoalContract } from "../../../src/v2/orchestration/goal-contract.ts";
import { storedGoalRequirementCoverage } from "../../../src/v2/orchestration/goal-requirement-coverage.ts";
import { loadRunLibrarySnapshotPg } from "../../../src/v2/orchestration/run-library-snapshot.ts";
import { getResourceByKeyPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  DESIGN_ARTICLE_GOAL,
  DESIGN_ARTICLE_SKILL_REF,
  seedDesignArticleLibraryGraph,
} from "../../v2/fixtures/design-article-library-graph.ts";
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

type RunGoalResult = {
  goalContractHash: string;
  draftId: string;
  draftStatus: string;
  runId?: string;
  runStatus?: string;
  blockers: string[];
};

type TaskEnvelopePayload = {
  envelope?: {
    schemaVersion?: string;
    skills?: Array<{ skillId?: string; version?: string; contentHash?: string }>;
  };
};

test("32 one prompt goal contract: design/article produces an offline article with frozen Library evidence", { timeout: 40 * 60 * 1000 }, async () => {
  const checkpoint = (message: string) => console.info(`[case32] ${message}`);
  const env = await createInitializedRealPostgresE2E();
  const materializationRoot = await mkdtemp("/tmp/case32-materialization-");
  const workspace = await mkdtemp("/tmp/case32-workspace-");
  let isolatedTork: Awaited<ReturnType<typeof startIsolatedRealTork>> | undefined;
  let server: Awaited<ReturnType<typeof createRealRuntimeServer>> | undefined;
  const requests: Array<{ method: string; path: string }> = [];

  try {
    await createArticleWorkspace(workspace);
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
    await seedDesignArticleLibraryGraph(env.db);
    server = await createRealRuntimeServer({ db: env.db, infra });

    const result = await api<RunGoalResult>(server.port, "/api/v2/run-goal", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({
        goalPrompt: DESIGN_ARTICLE_GOAL,
        cwd: workspace,
        idempotencyKey: `case32-${Date.now()}`,
      }),
    }, requests);
    if (result.draftStatus !== "validated") {
      const invalidDraft = await getResourceByKeyPg(env.db, "planner_draft", result.draftId);
      throw new Error(`Case32 planner draft ${result.draftStatus}: ${JSON.stringify({
        blockers: result.blockers,
        payload: invalidDraft?.payload,
      })}`);
    }
    assert.equal(result.runStatus, "scheduling");
    assert.ok(result.runId);
    const runId = result.runId;

    const draft = await getResourceByKeyPg(env.db, "planner_draft", result.draftId);
    assert.ok(draft);
    const draftPayload = draft.payload as Record<string, unknown>;
    const contract = storedGoalContract(draftPayload.goalContract);
    assert.ok(contract);
    assert.equal(contract.originalPrompt, DESIGN_ARTICLE_GOAL);
    assert.equal(contract.domain, "design/article");

    const coverage = storedGoalRequirementCoverage(draftPayload.goalRequirementCoverage);
    assert.ok(coverage);
    assert.equal(coverage.entries.flatMap((entry) => entry.requiredEvidenceKinds).includes("screenshot"), true);
    assert.equal(coverage.entries.flatMap((entry) => entry.requiredEvidenceKinds).includes("url"), true);

    const run = await env.db.one<{
      workflow_manifest_json: SouthstarWorkflowManifest;
      runtime_context_json: Record<string, unknown>;
    }>("select workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(run.workflow_manifest_json.domain, "design/article");
    const browserTasks = run.workflow_manifest_json.tasks.filter((task) =>
      (task.mcpGrantRefs ?? []).some((ref) => /browser|playwright/.test(ref))
    );
    assert.equal(browserTasks.length > 0, true, "expected a browser verifier task");
    assert.equal(browserTasks.every((task) => task.dependsOn.length > 0), true, "browser verification must follow article production");

    const frozenSnapshot = await loadRunLibrarySnapshotPg(env.db, runId);
    const frozenSkill = frozenSnapshot.objects.find((object) => object.objectKey === DESIGN_ARTICLE_SKILL_REF);
    assert.ok(frozenSkill, `${DESIGN_ARTICLE_SKILL_REF} missing from frozen snapshot`);
    const originalSkillContentHash = skillContentHash(frozenSkill);
    await upsertLibraryObject(env.db, {
      objectKey: frozenSkill.objectKey,
      objectKind: frozenSkill.objectKind,
      status: "approved",
      headVersionId: `${frozenSkill.objectKey}@v2-mutated-after-run`,
      state: { ...frozenSkill.state, instructions: "MUTATED AFTER RUN: this content must not enter TaskEnvelope." },
    });

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
      runRoot: materializationRoot,
    });
    const articlePath = join(workspace, "article/article.html");
    const screenshotPath = join(workspace, "article/offline-proof.png");
    let screenshotHash: string | undefined;
    let frozenEnvelopeChecked = false;
    const dispatched = new Set<string>();

    for (let wave = 1; wave <= run.workflow_manifest_json.tasks.length + 1; wave += 1) {
      const current = await env.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
      if (current.status === "completed") break;
      if (!screenshotHash && await fileExists(articlePath)) {
        screenshotHash = await verifyOfflineAndCapture(articlePath, screenshotPath);
        checkpoint(`offline screenshot sha256=${screenshotHash}`);
      }
      const dispatch = await scheduler.runOnce({ runId });
      if (dispatch.dispatchedTaskIds.length === 0) {
        throw new Error(`case32 scheduler made no progress at wave ${wave}: ${JSON.stringify(dispatch.skippedTaskIds)}`);
      }
      for (const taskId of dispatch.dispatchedTaskIds) {
        assert.equal(dispatched.has(taskId), false);
        dispatched.add(taskId);
        const envelope = await latestTaskEnvelope(env.db, { runId, taskId });
        const selectedSkill = envelope.envelope?.skills?.find((skill) => skill.skillId === DESIGN_ARTICLE_SKILL_REF);
        if (selectedSkill) {
          assert.equal(selectedSkill.version, frozenSkill.versionRef);
          assert.equal(selectedSkill.contentHash, originalSkillContentHash);
          frozenEnvelopeChecked = true;
        }
        const hand = await latestHandExecutionForTask(env.db, { runId, taskId });
        await waitForTorkJob(infra.torkBaseUrl, hand.externalJobId);
        assert.equal(await waitForHandExecutionStatus(env.db, hand.resourceKey, ["completed", "failed"]), "completed");
      }
    }

    assert.equal(await waitForPostgresRunStatus(env.db, runId, ["completed", "failed"]), "completed");
    assert.equal(frozenEnvelopeChecked, true, "expected a later TaskEnvelope to materialize the frozen article skill");
    assert.equal(await fileExists(articlePath), true);
    screenshotHash ??= await verifyOfflineAndCapture(articlePath, screenshotPath);
    const html = await readFile(articlePath, "utf8");
    assertSelfContainedArticle(html);

    const outcome = await getResourceByKeyPg(env.db, "goal_outcome", `goal-outcome:${runId}`);
    assert.equal(outcome?.status, "satisfied");
    const evidencePackets = (await listResourcesPg(env.db, { resourceType: "evidence_packet" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(evidencePackets.some((resource) =>
      ((resource.payload as { evidenceItems?: Array<{ kind?: string; status?: string; sha256?: string }> }).evidenceItems ?? [])
        .some((item) => item.kind === "screenshot" && item.status === "present" && item.sha256 === screenshotHash)
    ), true, "expected accepted screenshot evidence with the offline proof hash");

    assert.deepEqual(requests, [{ method: "POST", path: "/api/v2/run-goal" }]);
    assert.deepEqual(await loadRunLibrarySnapshotPg(env.db, runId), frozenSnapshot);
    checkpoint(`runId=${runId} article=${articlePath} screenshot=${screenshotPath}`);
  } finally {
    await server?.close();
    await isolatedTork?.close();
    await env.close();
    await rm(materializationRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createArticleWorkspace(workspace: string): Promise<void> {
  await writeFile(join(workspace, "input.md"), [
    "# Designing Calm Offline Reading",
    "",
    "A self-contained article should remain useful when connectivity disappears.",
    "",
    "## Principles",
    "",
    "- Keep typography readable and responsive.",
    "- Put all styles and behavior in one HTML document.",
    "- Preserve a clear heading hierarchy and accessible contrast.",
    "",
    "## Closing note",
    "",
    "Offline-first publishing turns a fragile page into a durable document.",
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "case32@southstar.test"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Southstar Case32"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "test: seed article input"], { cwd: workspace });
}

async function verifyOfflineAndCapture(htmlPath: string, screenshotPath: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.setOffline(true);
    const page = await context.newPage();
    const networkRequests: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) networkRequests.push(request.url());
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    assert.equal((await page.locator("body").innerText()).trim().length > 80, true);
    assert.deepEqual(networkRequests, []);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await context.close();
  } finally {
    await browser.close();
  }
  const bytes = await readFile(screenshotPath);
  assert.equal(bytes.length > 100, true);
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSelfContainedArticle(html: string): void {
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<(main|article)\b/i);
  assert.match(html, /<style\b/i);
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i);
}

function skillContentHash(skill: Awaited<ReturnType<typeof loadRunLibrarySnapshotPg>>["objects"][number]): string {
  const instructions = typeof skill.state.instructions === "string"
    ? skill.state.instructions
    : typeof skill.state.body === "string"
      ? skill.state.body
      : "";
  return createHash("sha256").update(JSON.stringify({
    skillRef: skill.objectKey,
    instructions,
    bundleFiles: skill.bundleFiles ?? [],
  })).digest("hex");
}

async function latestTaskEnvelope(
  db: Parameters<typeof createRealRecoveryScheduler>[0],
  input: { runId: string; taskId: string },
): Promise<TaskEnvelopePayload> {
  const row = await db.maybeOne<{ payload_json: TaskEnvelopePayload }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'task_envelope' and run_id = $1 and task_id = $2
      order by created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId],
  );
  if (!row) throw new Error(`task envelope missing for ${input.runId}/${input.taskId}`);
  return row.payload_json;
}

async function fileExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
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
