import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { buildContextPacket } from "../../src/v2/context/builder.ts";
import { createPlannerDraft, createRunFromDraft } from "../../src/v2/ui-api/local-api.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

test("builds auditable task context with memory injection trace", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-prefer-minimal",
    scope: "software",
    status: "approved",
    title: "Minimal change preference",
    payload: {
      kind: "preference",
      text: "Prefer minimal TypeScript changes with tests.",
      confidence: 0.9,
      successScore: 0.8,
      tags: ["software"],
    },
  });

  const packet = buildContextPacket(db, {
    runId: "run-ctx",
    taskId: "implement-feature",
    goalPrompt: "新增 calc sum",
    domainPack: softwareDomainPack,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    artifactContractRefs: ["implementation_report"],
    priorArtifactRefs: [],
    checkpointSummary: "No prior checkpoint.",
    workspaceSummary: "Fixture repo with calc add exists.",
  });

  assert.equal(packet.roleRef, "maker");
  assert.equal(packet.agentProfileRef, "software-maker-pi");
  assert.equal(packet.selectedMemories.length, 1);
  assert.match(packet.selectedMemories[0].text, /minimal TypeScript/);
  assert.equal(packet.skillInstructions.length >= 1, true);
  assert.equal(packet.mcpGrantSummary.length >= 1, true);
  assert.equal(packet.tokenEstimate.total > 0, true);

  const contextResource = db.prepare("select 1 from runtime_resources where resource_type = 'context_packet' and resource_key = ?").get(packet.id);
  assert.ok(contextResource);
  const trace = db.prepare("select payload_json from runtime_resources where resource_type = 'memory_injection_trace'").get() as {
    payload_json: string;
  };
  const payload = JSON.parse(trace.payload_json) as { included: unknown[]; excluded: unknown[]; tokenEstimate: number };
  assert.equal(payload.included.length, 1);
  assert.equal(Array.isArray(payload.excluded), true);
  assert.equal(payload.tokenEstimate > 0, true);
});

test("records policy kind mismatches as auditable memory exclusions", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-unsupported-kind",
    scope: "software",
    status: "approved",
    title: "Unsupported",
    payload: {
      kind: "unsupported_kind",
      text: "calc sum should prefer a very specific implementation approach",
      confidence: 1,
      successScore: 1,
      tags: ["software"],
    },
  });

  const packet = buildContextPacket(db, {
    runId: "run-ctx-kind",
    taskId: "implement-feature",
    goalPrompt: "calc sum implementation approach",
    domainPack: softwareDomainPack,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    artifactContractRefs: ["implementation_report"],
    priorArtifactRefs: [],
  });

  assert.equal(packet.selectedMemories.length, 0);
  assert.equal(packet.excludedCandidates[0]?.reason, "kind-mismatch");
  const trace = db.prepare("select payload_json from runtime_resources where resource_type = 'memory_injection_trace'").get() as {
    payload_json: string;
  };
  const payload = JSON.parse(trace.payload_json) as { excluded: Array<{ reason: string; score: number }> };
  assert.equal(payload.excluded[0]?.reason, "kind-mismatch");
  assert.equal(payload.excluded[0]?.score > 0, true);
});

test("persists distinct context packets and traces per execution attempt", () => {
  const db = openSouthstarDb(":memory:");
  for (const attempt of [1, 2]) {
    buildContextPacket(db, {
      runId: "run-ctx-attempt",
      taskId: "implement-feature",
      rootSessionId: "root-run-ctx-attempt-implement-feature",
      executionAttempt: attempt,
      goalPrompt: "calc sum implementation approach",
      domainPack: softwareDomainPack,
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      artifactContractRefs: ["implementation_report"],
      priorArtifactRefs: [],
    });
  }

  const contextRows = db.prepare("select resource_key from runtime_resources where resource_type = 'context_packet' order by resource_key").all() as Array<{
    resource_key: string;
  }>;
  const traceRows = db.prepare("select resource_key from runtime_resources where resource_type = 'memory_injection_trace' order by resource_key").all() as Array<{
    resource_key: string;
  }>;
  assert.deepEqual(contextRows.map((row) => row.resource_key), [
    "ctx-run-ctx-attempt-implement-feature-attempt-1",
    "ctx-run-ctx-attempt-implement-feature-attempt-2",
  ]);
  assert.deepEqual(traceRows.map((row) => row.resource_key), [
    "mem-trace-ctx-run-ctx-attempt-implement-feature-attempt-1",
    "mem-trace-ctx-run-ctx-attempt-implement-feature-attempt-2",
  ]);
});

test("fails closed when context packet exceeds max input token policy", () => {
  const db = openSouthstarDb(":memory:");
  const domainPack = {
    ...softwareDomainPack,
    contextPolicies: [{ ...softwareDomainPack.contextPolicies[0], maxInputTokens: 1 }],
  };

  assert.throws(() => buildContextPacket(db, {
    runId: "run-ctx-budget",
    taskId: "implement-feature",
    goalPrompt: "calc sum implementation approach",
    domainPack,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    artifactContractRefs: ["implementation_report"],
    priorArtifactRefs: [],
  }), /context packet exceeds maxInputTokens/);
});

test("persists exactly one context packet and memory trace per task before executor submission", async () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-include",
    scope: "software",
    status: "approved",
    title: "Include",
    payload: {
      kind: "preference",
      text: "Prefer tests around calc sum behavior.",
      confidence: 0.9,
      successScore: 0.9,
      tags: ["software"],
    },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-exclude",
    scope: "software",
    status: "approved",
    title: "Exclude",
    payload: {
      kind: "preference",
      text: "This is a very long preference that should be excluded by a deliberately tiny memory budget.",
      confidence: 0.9,
      successScore: 0.9,
      tags: ["software"],
    },
  });

  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: { generate: async () => { throw new Error("not used"); } },
  });
  const workflowResource = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?")
    .get(draft.draftId) as { payload_json: string };
  const bundle = JSON.parse(workflowResource.payload_json) as { workflow: { memoryPolicies?: Array<{ id: string; maxInjectedTokens: number }> } };
  const defaultPolicy = bundle.workflow.memoryPolicies?.find((policy) => policy.id === "software-memory-default");
  assert.ok(defaultPolicy);
  defaultPolicy.maxInjectedTokens = 12;
  upsertRuntimeResource(db, {
    resourceType: "planner_draft",
    resourceKey: draft.draftId,
    scope: "planner",
    status: "validated",
    title: "patched draft",
    payload: bundle,
  });

  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    submit: async ({ runId, workflow }) => {
      for (const task of workflow.tasks) {
        const contextRows = db.prepare(
          "select payload_json from runtime_resources where resource_type = 'context_packet' and run_id = ? and task_id = ?",
        ).all(runId, task.id) as Array<{ payload_json: string }>;
        const traceRows = db.prepare(
          "select payload_json from runtime_resources where resource_type = 'memory_injection_trace' and run_id = ? and task_id = ?",
        ).all(runId, task.id) as Array<{ payload_json: string }>;
        assert.equal(contextRows.length, 1);
        assert.equal(traceRows.length, 1);
        const context = JSON.parse(contextRows[0].payload_json) as { selectedMemories: unknown[]; excludedCandidates: unknown[] };
        const trace = JSON.parse(traceRows[0].payload_json) as {
          included: unknown[];
          excluded: unknown[];
          tokenEstimate: number;
        };
        assert.equal(Array.isArray(context.selectedMemories), true);
        assert.equal(Array.isArray(context.excludedCandidates), true);
        assert.equal(Array.isArray(trace.included), true);
        assert.equal(Array.isArray(trace.excluded), true);
        assert.equal(trace.tokenEstimate > 0, true);
      }
      return { executorType: "tork", externalJobId: "job-context", status: "queued" };
    },
  };

  const run = await createRunFromDraft(db, { draftId: draft.draftId, executorProvider });

  const implementedTrace = db.prepare(
    "select payload_json from runtime_resources where resource_type = 'memory_injection_trace' and run_id = ? and task_id = 'implement-feature'",
  ).get(run.runId) as { payload_json: string };
  const trace = JSON.parse(implementedTrace.payload_json) as { included: unknown[]; excluded: unknown[] };
  assert.equal(trace.included.length, 1);
  assert.equal(trace.excluded.length >= 1, true);
});

test("materialized task envelope only receives ContextPacket-selected memories", async () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-context-envelope-"));
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-selected-envelope",
    scope: "software",
    status: "approved",
    title: "Selected",
    payload: {
      kind: "preference",
      text: "Prefer tests around calc sum behavior.",
      confidence: 0.9,
      successScore: 0.9,
      tags: ["software"],
    },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-kind-mismatch-envelope",
    scope: "software",
    status: "approved",
    title: "Kind mismatch",
    payload: {
      kind: "unsupported_kind",
      text: "Do not let this unsupported memory reach the agent envelope.",
      confidence: 1,
      successScore: 1,
      tags: ["software"],
    },
  });

  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: { generate: async () => { throw new Error("not used"); } },
  });
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    submit: async ({ runId, workflow }) => {
      for (const task of workflow.tasks) {
        const envelopePath = join(runRoot, runId, task.id, "envelope.json");
        const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as {
          schemaVersion: string;
          agentPrompt: string;
          contextPacket: { selectedMemories: unknown[]; excludedCandidates: Array<{ reason: string }> };
        };
        assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
        assert.match(envelope.agentPrompt, /ContextPacket:/);
        assert.match(envelope.agentPrompt, /Prefer tests around calc sum behavior/);
        assert.doesNotMatch(envelope.agentPrompt, /unsupported memory reach/);
        assert.equal(envelope.contextPacket.selectedMemories.length, 1);
        assert.equal(envelope.contextPacket.excludedCandidates.some((candidate) => candidate.reason === "kind-mismatch"), true);
      }
      return { executorType: "tork", externalJobId: "job-context-envelope", status: "queued" };
    },
  };

  await createRunFromDraft(db, { draftId: draft.draftId, executorProvider, runRoot });
});

test("materialized task envelope resolves agent profile skills and MCP grants", async () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-context-grants-"));
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum with tests",
    plannerClient: { generate: async () => { throw new Error("not used"); } },
  });

  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    submit: async ({ runId, workflow }) => {
      const task = workflow.tasks.find((candidate) => candidate.agentProfileRef === "software-maker-pi");
      assert.ok(task);
      const envelopePath = join(runRoot, runId, task.id, "envelope.json");
      const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as {
        agentProfile: { id: string; model?: string; skillRefs: string[]; mcpGrantRefs: string[]; memoryScopes: string[] };
        skills: Array<{ skillId: string }>;
        mcpGrants: Array<{ serverId: string; allowedTools: string[] }>;
        contextPacket: { agentProfileRef: string; skillInstructions: unknown[]; mcpGrantSummary: unknown[] };
      };
      assert.equal(envelope.agentProfile.id, "software-maker-pi");
      assert.equal(envelope.agentProfile.model, "pi-agent-default");
      assert.deepEqual(envelope.agentProfile.memoryScopes, ["software", "project"]);
      assert.deepEqual(envelope.agentProfile.skillRefs, ["software.calc-cli"]);
      assert.deepEqual(envelope.skills.map((skill) => skill.skillId), ["software.calc-cli"]);
      assert.deepEqual(envelope.agentProfile.mcpGrantRefs, ["filesystem-workspace"]);
      assert.deepEqual(envelope.mcpGrants, [{
        serverId: "filesystem-workspace",
        allowedTools: ["read", "search", "edit", "shell"],
      }]);
      assert.equal(envelope.contextPacket.agentProfileRef, "software-maker-pi");
      assert.equal(envelope.contextPacket.skillInstructions.length, 1);
      assert.equal(envelope.contextPacket.mcpGrantSummary.length, 1);
      return { executorType: "tork", externalJobId: "job-context-grants", status: "queued" };
    },
  };

  await createRunFromDraft(db, { draftId: draft.draftId, executorProvider, runRoot });
});

test("materialized task routing follows resolved agent profile instead of task id", async () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-context-routing-"));
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: { generate: async () => { throw new Error("not used"); } },
  });
  const workflowResource = db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?")
    .get(draft.draftId) as { payload_json: string };
  const bundle = JSON.parse(workflowResource.payload_json) as { workflow: { tasks: Array<{ id: string; agentProfileRef?: string }> } };
  const understandTask = bundle.workflow.tasks.find((task) => task.id === "understand-repo");
  assert.ok(understandTask);
  understandTask.agentProfileRef = "software-explorer-pi";
  upsertRuntimeResource(db, {
    resourceType: "planner_draft",
    resourceKey: draft.draftId,
    scope: "planner",
    status: "validated",
    title: "patched draft",
    payload: bundle,
  });

  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    submit: async ({ runId, workflow }) => {
      const task = workflow.tasks.find((candidate) => candidate.id === "understand-repo");
      assert.ok(task);
      assert.equal(task.execution.env.SOUTHSTAR_HARNESS_KIND, undefined);
      const envelopePath = join(runRoot, runId, task.id, "envelope.json");
      const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as {
        agentProfile: { id: string; provider: string };
        harness: { id: string; kind: string };
      };
      assert.equal(envelope.agentProfile.id, "software-explorer-pi");
      assert.equal(envelope.agentProfile.provider, "pi");
      assert.equal(envelope.harness.id, "pi");
      assert.equal(envelope.harness.kind, "pi-agent");
      return { executorType: "tork", externalJobId: "job-context-routing", status: "queued" };
    },
  };

  await createRunFromDraft(db, { draftId: draft.draftId, executorProvider, runRoot });
});
