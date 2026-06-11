import assert from "node:assert/strict";
import test from "node:test";
import "./browser-evidence.test.ts";
import "./spec-to-issues-live.test.ts";
import {
  productHardeningLiveEnabled,
  requireProductHardeningLiveEnv,
} from "./env.ts";
import {
  assertProductHardeningMetrics,
  emptyProductHardeningMetrics,
  finalizeProductHardeningMetrics,
  formatProductHardeningSummary,
} from "./metrics.ts";
import {
  cleanupProductHardeningFailureArtifacts,
  createProductHardeningIssuePlan,
  productHardeningEvidenceRoot,
  productHardeningProjectReadBackFields,
  runProductHardeningLiveE2E,
  writeProductHardeningConsumerConfig,
} from "./harness.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("product hardening live E2E clear-skips without live flag", (t) => {
  if (!productHardeningLiveEnabled()) {
    t.skip("Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 with GitHub repo, Project id, and SDK credentials to run product hardening live E2E.");
    return;
  }

  requireProductHardeningLiveEnv();
});

test("env parser reports actionable live configuration gaps", () => {
  assert.throws(
    () => requireProductHardeningLiveEnv({
      NORTHSTAR_PRODUCT_HARDENING_LIVE: "1",
    }),
    /Missing product hardening live E2E configuration: GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO, NORTHSTAR_LIVE_GITHUB_PROJECT_ID, SDK credentials/,
  );
});

test("metrics assertion rejects smoke-only or fake live paths", () => {
  const metrics = emptyProductHardeningMetrics();
  metrics.live_issues_created = 5;
  metrics.live_completed_issues = 5;
  metrics.live_prs_merged = 5;
  metrics.live_project_lifecycle_completed = 5;
  metrics.live_project_status_done = 5;
  metrics.live_parallel_active_issue_workers = 2;
  metrics.parallel_overlap_seconds = 1;
  metrics.live_browser_tests_passed = 1;
  metrics.live_smoke_only = 1;

  assert.throws(() => assertProductHardeningMetrics(metrics), /live_smoke_only must equal 0/);
});

test("offline harness plan is one five-issue dependency graph", () => {
  const plan = createProductHardeningIssuePlan("unit-run");

  assert.deepEqual(plan.map((issue) => issue.key), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(plan.map((issue) => [issue.key, issue.dependsOn]), [
    ["A", []],
    ["B", ["A"]],
    ["C", ["A"]],
    ["D", ["B", "C"]],
    ["E", ["D"]],
  ]);
  assert.equal(new Set(plan.map((issue) => issue.consumerRunId)).size, 1);
});

test("offline harness writes one consumer config with capacity two and Project sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "northstar-product-hardening-config-"));
  try {
    await writeProductHardeningConsumerConfig({
      consumerRoot: root,
      repo: "owner/repo",
      projectId: "PVT_kwDOExample",
    });
    const config = await readFile(join(root, ".northstar.yaml"), "utf8");

    assert.match(config, /runtime:\n(?:.*\n)*?  development_capacity: 2/);
    assert.match(config, /github:\n(?:.*\n)*?  project:\n(?:.*\n)*?    enabled: true\n(?:.*\n)*?    project_id: PVT_kwDOExample/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline harness evidence path is under the consumer runtime root", () => {
  const root = join(tmpdir(), "consumer-root");

  assert.equal(
    productHardeningEvidenceRoot(root),
    join(root, ".northstar/runtime/evidence/product-hardening-live"),
  );
});

test("offline harness requires independent Project field read-back", () => {
  assert.deepEqual(productHardeningProjectReadBackFields, [
    "Northstar Lifecycle",
    "Status",
    "PR URL",
    "Merge SHA",
  ]);
});

test("offline failure cleanup labels/comments issues and closes/comments matching PRs", async () => {
  const calls: Array<{ type: string; number: number; body?: string; labels?: string[] }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (path.endsWith("/search/issues")) {
      return jsonResponse({
        items: [
          { number: 88, html_url: "https://github.test/owner/repo/pull/88" },
          { number: 89, html_url: "https://github.test/owner/repo/pull/89" },
        ],
      });
    }
    if (path.endsWith("/issues/88/comments")) {
      calls.push({ type: "pr-comment", number: 88, body: body.body });
      return jsonResponse({});
    }
    if (path.endsWith("/issues/89/comments")) {
      calls.push({ type: "pr-comment", number: 89, body: body.body });
      return jsonResponse({});
    }
    if (path.endsWith("/pulls/88")) {
      calls.push({ type: "pr-close", number: 88 });
      return jsonResponse({});
    }
    if (path.endsWith("/pulls/89")) {
      calls.push({ type: "pr-close", number: 89 });
      return jsonResponse({});
    }

    return jsonResponse({});
  };

  await cleanupProductHardeningFailureArtifacts({
    github: {
      addLabels: async (number: number, labels: string[]) => {
        calls.push({ type: "issue-label", number, labels });
      },
      addIssueComment: async (number: number, body: string) => {
        calls.push({ type: "issue-comment", number, body });
        return { html_url: `https://github.test/issues/${number}#comment` };
      },
      closeIssue: async (number: number) => {
        calls.push({ type: "issue-close", number });
        return { state: "closed" };
      },
    },
    issues: [
      {
        key: "A",
        dependsOn: [],
        consumerRunId: "run-123",
        outputFile: "product-hardening-live/run-123/A.txt",
        expectedContent: "run-123:A",
        issueNumber: 44,
        issueUrl: "https://github.test/owner/repo/issues/44",
      },
    ],
    error: new Error("assertion failed with token gho_should_be_redacted"),
    repo: "owner/repo",
    token: "gho_fake",
    runId: "run-123",
    fetch: fetchImpl,
  });

  assert.deepEqual(calls.filter((call) => call.type === "issue-label"), [
    { type: "issue-label", number: 44, labels: ["northstar:product-hardening-live-cleanup"] },
  ]);
  assert.match(calls.find((call) => call.type === "issue-comment")?.body ?? "", /Product hardening live E2E failed and cleaned up this issue/);
  assert.doesNotMatch(calls.find((call) => call.type === "issue-comment")?.body ?? "", /gho_should_be_redacted/);
  assert.deepEqual(calls.filter((call) => call.type === "issue-close"), [{ type: "issue-close", number: 44 }]);
  assert.deepEqual(calls.filter((call) => call.type === "pr-close").map((call) => call.number), [88, 89]);
  assert.equal(calls.filter((call) => call.type === "pr-comment").length, 2);
});

test("offline harness keeps smoke-only set until real live assertions complete", () => {
  const metrics = emptyProductHardeningMetrics();

  assert.equal(metrics.live_smoke_only, 1);
  assert.throws(
    () => finalizeProductHardeningMetrics(metrics, {
      runtimeFlowComplete: true,
      projectReadBackComplete: false,
      browserEvidenceComplete: true,
      runtimeHistoryMetricsComplete: true,
    }),
    /live_smoke_only cannot be cleared/,
  );
  assert.equal(metrics.live_smoke_only, 1);
});

test("metrics summary includes every required product hardening metric", () => {
  const summary = formatProductHardeningSummary(emptyProductHardeningMetrics());

  for (const key of [
    "live_issues_created",
    "live_completed_issues",
    "live_prs_merged",
    "live_project_lifecycle_completed",
    "live_project_status_done",
    "live_parallel_active_issue_workers",
    "parallel_overlap_seconds",
    "dependency_order_violations",
    "github_project_status_mismatches",
    "live_browser_tests_passed",
    "live_secret_leaks",
    "fake_production_path_used",
  ]) {
    assert.match(summary, new RegExp(`${key}=0`));
  }
  assert.match(summary, /live_smoke_only=1/);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("live harness refuses to fake acceptance when live config is incomplete", async () => {
  await assert.rejects(
    () => runProductHardeningLiveE2E({
      repo: "owner/repo",
      projectId: "PVT_kwDOExample",
      token: "gho_example",
      sdkCredentialsAvailable: false,
    }),
    /SDK credentials are required/,
  );
});

test("product hardening live E2E verifies sequential, parallel, Project, and browser evidence", async (t) => {
  if (!productHardeningLiveEnabled()) {
    t.skip("Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 to run product hardening live E2E.");
    return;
  }

  const env = requireProductHardeningLiveEnv();
  const result = await runProductHardeningLiveE2E(env);

  t.diagnostic(JSON.stringify(result.metrics, null, 2));
  t.diagnostic(`issues=${result.issueUrls.join(",")}`);
  t.diagnostic(`prs=${result.prUrls.join(",")}`);
  t.diagnostic(`browser_evidence=${result.browserEvidencePath}`);

  assertProductHardeningMetrics(result.metrics);
});
