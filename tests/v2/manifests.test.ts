import test from "node:test";
import assert from "node:assert/strict";
import { validatePlanBundle } from "../../src/v2/manifests/validate.ts";
import type { PlanBundle } from "../../src/v2/manifests/types.ts";

test("validates a canonical Southstar workflow manifest", () => {
  const bundle = makeBundle();

  assert.deepEqual(validatePlanBundle(bundle), { ok: true, issues: [] });
});

test("rejects unknown harness references and non-Tork execution", () => {
  const bundle = makeBundle();
  bundle.workflow.tasks[0].execution.engine = "local" as never;
  bundle.workflow.tasks[0].subagents[0].harnessId = "missing";

  const result = validatePlanBundle(bundle);

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("\n"), /must be tork/);
  assert.match(result.issues.map((issue) => issue.message).join("\n"), /unknown harness id/);
});

test("rejects task dependency cycles", () => {
  const bundle = makeBundle();
  bundle.workflow.tasks.push({
    ...bundle.workflow.tasks[0],
    id: "task-cycle",
    name: "Cycle",
    dependsOn: ["task-implement"],
  });
  bundle.workflow.tasks[0].dependsOn = ["task-cycle"];

  const result = validatePlanBundle(bundle);

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("\n"), /cycle/);
});

test("validates compiledFrom metadata when present", () => {
  const bundle = makeBundle();
  bundle.workflow.compiledFrom = {
    templateDefinitionId: "obj-software-template",
    templateVersionId: "ver-software-template-1",
    compilerVersion: "design-library-compiler-v1",
    inputHash: "1".repeat(64),
    libraryVersionRefs: ["ver-software-template-1"],
  };
  assert.deepEqual(validatePlanBundle(bundle), { ok: true, issues: [] });

  bundle.workflow.compiledFrom.inputHash = "not-sha256";
  const invalid = validatePlanBundle(bundle);
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.map((issue) => issue.path).join("\n"), /compiledFrom\.inputHash/);
});

test("compiledFrom includes its selected template version in immutable Library refs", () => {
  const bundle = makeBundle();
  bundle.workflow.compiledFrom = {
    templateDefinitionId: "template.software-feature",
    templateVersionId: "template.software-feature@1",
    compilerVersion: "library-constrained-compiler-v1",
    inputHash: "1".repeat(64),
    libraryVersionRefs: ["agent.software-maker@1"],
  };

  const result = validatePlanBundle(bundle);

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), /templateVersionId.*libraryVersionRefs/i);
});

function makeBundle(): PlanBundle {
  return {
    workflow: {
      schemaVersion: "southstar.v2",
      workflowId: "wf-software-mvp",
      title: "Software MVP",
      goalPrompt: "implement calc sum",
      tasks: [{
        id: "task-implement",
        name: "Implement CLI",
        domain: "software",
        dependsOn: [],
        execution: {
          engine: "tork",
          image: "southstar/codex-agent:local",
          command: ["southstar-agent-runner", "--task-id", "task-implement"],
          env: {},
          mounts: [],
          timeoutSeconds: 900,
          infraRetry: { maxAttempts: 1 },
        },
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
        subagents: [{
          id: "impl",
          harnessId: "codex",
          prompt: "implement",
          requiredArtifacts: ["implementation-report"],
        }],
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
      evaluators: [{
        id: "schema-evaluator-v1",
        kind: "schema",
        artifactTypes: ["implementation-report"],
        requiredFields: ["summary", "commandsRun", "risks"],
      }],
      memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
      vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
      steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
      learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    },
    plannerTrace: { model: "pi-agent", promptHash: "hash", generatedAt: "2026-06-11T00:00:00.000Z" },
  };
}
