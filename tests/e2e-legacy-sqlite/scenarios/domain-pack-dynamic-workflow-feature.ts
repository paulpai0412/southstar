import assert from "node:assert/strict";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { validateWorkflowManifest } from "../../../src/v2/manifests/validate.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertDomainPackDynamicWorkflowEvidence,
  assertFixtureTests,
  assertNoE2eStaticManifestUsage,
  assertTorkProjectionIsExecutorOnly,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export type DomainPackDynamicWorkflowFeatureResult = {
  runId: string;
  repo: string;
  timings: {
    plannerMs: number;
    validationMs: number;
    torkSubmitMs: number;
    e2eMs: number;
  };
};

export async function runDomainPackDynamicWorkflowFeatureScenario(
  env: RealE2EEnv,
): Promise<DomainPackDynamicWorkflowFeatureResult> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const maxAttempts = 2;
  let lastFailure = "domain-pack dynamic workflow run failed without details";

  try {
    const repoNames = ["mvp-software-change", "ui-browser-operations-real"];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const repo = prepareSoftwareFixtureRepo(env, repoNames[Math.min(attempt - 1, repoNames.length - 1)]!);
      const goalPrompt = domainPackDynamicWorkflowGoalPrompt(repo);

      const plannerStartedAt = Date.now();
      const draft = await createPlannerDraft(context.db, {
        goalPrompt,
        plannerClient: context.plannerClient,
      });
      const plannerMs = Date.now() - plannerStartedAt;

      const validationStartedAt = Date.now();
      const draftRow = context.db.prepare(`
        select payload_json
        from runtime_resources
        where resource_type = 'planner_draft' and resource_key = ?
      `).get(draft.draftId) as { payload_json: string } | undefined;
      assert.ok(draftRow, `missing planner draft ${draft.draftId}`);
      const draftPayload = JSON.parse(draftRow.payload_json) as {
        workflow: Parameters<typeof validateWorkflowManifest>[0];
      };
      const validation = validateWorkflowManifest(draftPayload.workflow);
      const validationMs = Date.now() - validationStartedAt;
      assert.equal(validation.ok, true, JSON.stringify(validation.issues));

      const torkStartedAt = Date.now();
      const run = await createRunFromDraft(context.db, {
        draftId: draft.draftId,
        torkClient: context.torkClient,
        runRoot: "/tmp/southstar-runs",
        callbackUrl: callback.url,
        harnessEndpoint: env.piHarnessEndpoint,
      });
      const torkSubmitMs = Date.now() - torkStartedAt;

      try {
        await waitForTorkJob(env.torkBaseUrl, run.tork.jobId);
        await waitForRunStatus(context.db, run.runId, ["passed", "completed", "failed"], 240_000);

        const runStatus = readRunStatus(context.db, run.runId);
        if (runStatus === "passed" || runStatus === "completed") {
          assertCalcSum(repo);
          assertFixtureTests(repo);
          assertNoE2eStaticManifestUsage(context.db, run.runId);
          assertDomainPackDynamicWorkflowEvidence(context.db, run.runId);
          assertTorkProjectionIsExecutorOnly(context.db, run.runId);

          console.log(`domain-pack dynamic workflow feature scenario passed (attempt ${attempt})`);
          return {
            runId: run.runId,
            repo,
            timings: {
              plannerMs,
              validationMs,
              torkSubmitMs,
              e2eMs: Date.now() - startedAt,
            },
          };
        }

        lastFailure = summarizeRunFailure(context.db, run.runId);
      } catch (error) {
        lastFailure = `run ${run.runId} / job ${run.tork.jobId}: ${(error as Error).message}`;
      }
      console.warn(`domain-pack dynamic workflow feature scenario attempt ${attempt} failed: ${lastFailure}`);
    }

    throw new Error(`domain-pack dynamic workflow feature scenario exhausted retries: ${lastFailure}`);
  } finally {
    await callback.close();
  }
}

function readRunStatus(db: ReturnType<typeof createScenarioContext>["db"], runId: string): string {
  const row = db.prepare("select status from workflow_runs where id = ?").get(runId) as { status: string } | undefined;
  return row?.status ?? "unknown";
}

function summarizeRunFailure(db: ReturnType<typeof createScenarioContext>["db"], runId: string): string {
  const row = db.prepare(`
    select payload_json
    from runtime_resources
    where run_id = ? and resource_type = 'validator_result' and status = 'failed'
    order by updated_at desc
    limit 1
  `).get(runId) as { payload_json: string } | undefined;
  if (!row) return `run ${runId} finished with status=${readRunStatus(db, runId)}`;
  try {
    const payload = JSON.parse(row.payload_json) as {
      validatorRef?: string;
      messages?: Array<{ text?: string }>;
    };
    const message = payload.messages?.[0]?.text ?? "unknown validator failure";
    return `${payload.validatorRef ?? "validator"}: ${message}`;
  } catch {
    return `run ${runId} failed with unreadable validator payload`;
  }
}

function domainPackDynamicWorkflowGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成一個可驗收的軟體 feature：",
    "新增 CLI 指令 `calc sum <numbers...>`，支援多個數字輸入、負數、小數、無效輸入錯誤訊息。",
    "同步更新單元測試與 README 用法。",
    "Southstar 必須自動判斷 domain/intent。",
    "依 software domain pack 動態產生 workflow DAG，不可固定四個 task。",
    "每個 task 必須解析 role、agent profile、provider/model、skills、MCP grants、memory scope。",
    "每次 agent 執行前必須保存可追蹤 ContextPacket，知道 memory 為什麼被注入。",
    "任務必須透過 Docker/Tork 執行，Tork 只能是 executor，不能保存 workflow truth。",
    "產生 artifact 後必須由 evaluator pipeline 驗收。",
    "驗收失敗時 RootSession 必須至少記錄 retry、fork session、rollback workspace 或 workflow revision 的 recovery decision。",
    "session 必須有 checkpoint/fork/reset/rollback lineage；Git/worktree 可用於 software workspace snapshot 與 rollback。",
    "最後只有 stop condition 通過，run 才能標記 passed/completed。",
    "artifact 必須包含 summary、filesChanged、commandsRun、testResults、risks、artifactEvidence。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}
