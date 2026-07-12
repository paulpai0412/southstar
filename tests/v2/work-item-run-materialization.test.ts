import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { getWorkItemPg } from "../../src/v2/work-items/postgres-work-items.ts";
import { materializeRunFromWorkItemPg } from "../../src/v2/work-items/run-materialization.ts";
import { loadRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

const executionProjection = { executor: "pending", queue: "managed-runtime" };

test("materializeRunFromWorkItemPg intakes work item, creates run, and links attempt context", async () => {
  const db = await createTestPostgresDb();
  try {
    const result = await materializeRunFromWorkItemPg(db, {
      sourceProvider: "api",
      sourceRef: "request-runtime-hardening",
      title: "Runtime hardening request",
      body: "Materialize runtime hardening work item",
      domain: "software",
      runId: "run-runtime-hardening-materialized",
      workflowManifest: workflowManifest(),
      executionProjection,
    });

    assert.equal(result.runId, "run-runtime-hardening-materialized");
    assert.equal(result.runAttempt, 1);

    const workItem = await getWorkItemPg(db, result.workItemId);
    assert.equal(workItem?.runRefs[0]?.runId, "run-runtime-hardening-materialized");
    assert.equal(workItem?.runRefs[0]?.runAttempt, 1);

    const run = await db.one<{
      status: string;
      domain: string;
      goal_prompt: string;
      workflow_manifest_json: SouthstarWorkflowManifest;
      execution_projection_json: typeof executionProjection;
      snapshot_json: Record<string, unknown>;
      runtime_context_json: { workItemRef?: { workItemId?: string; runAttempt?: number } };
      metrics_json: Record<string, unknown>;
    }>("select status, domain, goal_prompt, workflow_manifest_json, execution_projection_json, snapshot_json, runtime_context_json, metrics_json from southstar.workflow_runs where id = $1", [result.runId]);
    assert.equal(run.status, "created");
    assert.equal(run.domain, "software");
    assert.equal(run.goal_prompt, "Materialize runtime hardening work item");
    assert.deepEqual(run.workflow_manifest_json, workflowManifest());
    assert.deepEqual(run.execution_projection_json, executionProjection);
    assert.deepEqual(run.snapshot_json, {});
    assert.deepEqual(run.metrics_json, {});
    assert.equal(run.runtime_context_json.workItemRef?.workItemId, result.workItemId);
    assert.equal(run.runtime_context_json.workItemRef?.runAttempt, 1);
    const librarySnapshot = await loadRunLibrarySnapshotPg(db, result.runId);
    assert.equal(librarySnapshot.runId, result.runId);
    assert.deepEqual(librarySnapshot.objects, []);
    assert.equal(librarySnapshot.goalContractHash, undefined);
    assert.equal(librarySnapshot.manifestHash, contentHashForPayload(workflowManifest()));
    assert.match(librarySnapshot.snapshotHash, /^[a-f0-9]{64}$/);
  } finally {
    await db.close();
  }
});

test("materializeRunFromWorkItemPg retries same source and run id without duplicating run refs", async () => {
  const db = await createTestPostgresDb();
  try {
    const input = {
      sourceProvider: "api" as const,
      sourceRef: "request-runtime-hardening-retry",
      title: "Runtime hardening retry request",
      body: "Materialize runtime hardening retry work item",
      domain: "software",
      runId: "run-runtime-hardening-retry",
      workflowManifest: workflowManifest(),
      executionProjection,
    };

    const first = await materializeRunFromWorkItemPg(db, input);
    const second = await materializeRunFromWorkItemPg(db, input);

    assert.deepEqual(second, first);
    assert.equal(second.runAttempt, 1);
    const workItem = await getWorkItemPg(db, first.workItemId);
    assert.deepEqual(workItem?.runRefs.map((ref) => ({ runId: ref.runId, runAttempt: ref.runAttempt })), [
      { runId: "run-runtime-hardening-retry", runAttempt: 1 },
    ]);
  } finally {
    await db.close();
  }
});

test("materializeRunFromWorkItemPg captures exact compiled Library object-version refs", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-work-item-library-"));
  try {
    await mkdir(join(libraryRoot, "skills", "work-item", "references"), { recursive: true });
    await writeFile(join(libraryRoot, "skills", "work-item", "references", "guide.md"), "FROZEN WORK ITEM GUIDE", "utf8");
    await upsertLibraryObject(db, {
      objectKey: "template.work-item",
      objectKind: "workflow_template",
      status: "approved",
      headVersionId: "template.work-item@1",
      state: { title: "Work Item Template" },
    });
    await upsertLibraryObject(db, {
      objectKey: "skill.work-item",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.work-item@1",
      state: { body: "Use the work-item skill.", assetBundlePath: "library/skills/work-item" },
    });
    const manifest = workflowManifest();
    manifest.tasks[0]!.skillRefs = ["skill.work-item"];
    manifest.compiledFrom = {
      templateDefinitionId: "template.work-item",
      templateVersionId: "template.work-item@1",
      compilerVersion: "test-compiler-v1",
      inputHash: "1".repeat(64),
      libraryVersionRefs: ["template.work-item@1", "skill.work-item@1"],
      libraryObjectVersionRefs: [
        { objectKey: "template.work-item", versionRef: "template.work-item@1" },
        { objectKey: "skill.work-item", versionRef: "skill.work-item@1" },
      ],
    };

    const result = await materializeRunFromWorkItemPg(db, {
      sourceProvider: "api",
      sourceRef: "request-compiled-library-refs",
      title: "Compiled Library refs",
      body: "Materialize exact compiled Library refs",
      domain: "software",
      runId: "run-compiled-library-refs",
      workflowManifest: manifest,
      executionProjection,
      libraryRoot,
    });

    const snapshot = await loadRunLibrarySnapshotPg(db, result.runId);
    assert.deepEqual(
      snapshot.objects.map((object) => ({ objectKey: object.objectKey, versionRef: object.versionRef })),
      [...manifest.compiledFrom.libraryObjectVersionRefs].sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
    );
    const skill = snapshot.objects.find((object) => object.objectKey === "skill.work-item");
    assert.equal(Buffer.from(skill?.bundleFiles?.[0]?.contentBase64 ?? "", "base64").toString("utf8"), "FROZEN WORK ITEM GUIDE");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("materializeRunFromWorkItemPg rejects existing run id with conflicting payload", async () => {
  const db = await createTestPostgresDb();
  try {
    const input = {
      sourceProvider: "api" as const,
      sourceRef: "request-runtime-hardening-conflict",
      title: "Runtime hardening conflict request",
      body: "Materialize runtime hardening conflict work item",
      domain: "software",
      runId: "run-runtime-hardening-conflict",
      workflowManifest: workflowManifest(),
      executionProjection,
    };
    await materializeRunFromWorkItemPg(db, input);

    await assert.rejects(
      () => materializeRunFromWorkItemPg(db, {
        ...input,
        executionProjection: { ...executionProjection, queue: "other-queue" },
      }),
      /workflow run already exists with conflicting materialization payload: run-runtime-hardening-conflict/,
    );
  } finally {
    await db.close();
  }
});

test("work item materialize-run route creates linked run", async () => {
  const db = await createTestPostgresDb();
  const server = await createSouthstarRuntimeServer({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
  try {
    const result = await post<{ workItemId: string; runId: string; runAttempt: number }>(
      server.url,
      "/api/v2/work-items/materialize-run",
      {
        sourceProvider: "api",
        sourceRef: "request-runtime-hardening",
        sourceUrl: "https://example.test/runtime-hardening",
        title: "Runtime hardening route request",
        body: "Materialize route work item",
        domain: "software",
        runId: "run-runtime-hardening-route",
        workflowManifest: workflowManifest(),
        executionProjection,
        metadata: { requestedFrom: "route-test" },
      },
    );

    assert.equal(result.runId, "run-runtime-hardening-route");
    assert.equal(result.runAttempt, 1);

    const workItem = await getWorkItemPg(db, result.workItemId);
    assert.equal(workItem?.runRefs[0]?.runId, "run-runtime-hardening-route");

    const run = await db.one<{ runtime_context_json: { workItemRef?: { workItemId?: string; runAttempt?: number } } }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [result.runId],
    );
    assert.equal(run.runtime_context_json.workItemRef?.workItemId, result.workItemId);
    assert.equal(run.runtime_context_json.workItemRef?.runAttempt, 1);
  } finally {
    await server.close();
    await db.close();
  }
});

test("work item materialize-run route rejects invalid manifest without creating a run", async () => {
  const db = await createTestPostgresDb();
  const server = await createSouthstarRuntimeServer({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
  try {
    const response = await fetch(`${server.url}/api/v2/work-items/materialize-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProvider: "api",
        sourceRef: "request-invalid-manifest",
        title: "Invalid manifest request",
        body: "Materialize invalid manifest",
        domain: "software",
        runId: "run-invalid-manifest",
        workflowManifest: { schemaVersion: "southstar.v2", workflowId: "wf-invalid", title: "Invalid", goalPrompt: "Invalid", tasks: [] },
        executionProjection,
      }),
    });

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.match(envelope.error, /workflow manifest validation failed/);
    const run = await db.maybeOne("select id from southstar.workflow_runs where id = $1", ["run-invalid-manifest"]);
    assert.equal(run, null);
  } finally {
    await server.close();
    await db.close();
  }
});

test("work item materialize-run route rejects malformed metadata", async () => {
  const db = await createTestPostgresDb();
  const server = await createSouthstarRuntimeServer({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
  try {
    const response = await fetch(`${server.url}/api/v2/work-items/materialize-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceProvider: "api",
        sourceRef: "request-invalid-metadata",
        title: "Invalid metadata request",
        body: "Materialize invalid metadata",
        domain: "software",
        runId: "run-invalid-metadata",
        workflowManifest: workflowManifest(),
        executionProjection,
        metadata: "not-an-object",
      }),
    });

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.equal(envelope.error, "metadata must be an object");
    const run = await db.maybeOne("select id from southstar.workflow_runs where id = $1", ["run-invalid-metadata"]);
    assert.equal(run, null);
  } finally {
    await server.close();
    await db.close();
  }
});

async function post<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

function workflowManifest(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-runtime-hardening",
    title: "Runtime hardening",
    goalPrompt: "Materialize runtime hardening work item",
    tasks: [{
      id: "task-implement",
      name: "Implement runtime hardening",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/codex-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    }],
    harnessDefinitions: [{
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar/codex-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v1",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}
