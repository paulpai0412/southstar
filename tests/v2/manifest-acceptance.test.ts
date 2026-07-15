import test from "node:test";
import assert from "node:assert/strict";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";
import type { WorkflowCompositionValidationResult } from "../../src/v2/design-library/types.ts";
import {
  acceptWorkflowComposition,
  materializeWorkflowTaskProfileOverrides,
} from "../../src/v2/orchestration/manifest-acceptance.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";

const composition = { schemaVersion: "southstar.workflow_composition_plan.v1", tasks: [] };
const acceptedComposition: WorkflowCompositionValidationResult = { ok: true, issues: [] };

function workflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-acceptance",
    title: "Acceptance",
    goalPrompt: "accept workflow",
    tasks: [{
      id: "task",
      name: "task",
      dependsOn: [],
      agentProfileRef: "profile",
      execution: { engine: "tork", command: ["southstar-agent-runner"], infraRetry: { maxAttempts: 1 } },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      subagents: [{ id: "agent", harnessId: "harness", prompt: "run" }],
    }],
    agentProfiles: [{
      id: "profile",
      name: "profile",
      agentsMdRefs: [],
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopes: [],
      toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: {},
    }],
    harnessDefinitions: [{ id: "harness" }],
    evaluators: [{ id: "schema-evaluator-v1" }],
    compiledFrom: {
      sourceKind: "library_primitives",
      compilerVersion: "library-constrained-compiler-v1",
      inputHash: contentHashForPayload(composition),
      libraryVersionRefs: ["profile@1"],
      libraryObjectVersionRefs: [{ objectKey: "profile", versionRef: "profile@1" }],
    },
  } as unknown as SouthstarWorkflowManifest;
}

test("acceptance preserves composition validation issues", () => {
  const result = acceptWorkflowComposition({
    composition,
    compositionValidation: {
      ok: false,
      issues: [{ code: "unknown_candidate", path: "tasks.0.agentProfileRef", message: "not approved" }],
    },
    workflow: workflow(),
  });

  assert.deepEqual(result.issues[0], {
    code: "unknown_candidate",
    path: "tasks.0.agentProfileRef",
    message: "not approved",
  });
});

test("acceptance validates composition provenance and materializes the profile contract", () => {
  const candidate = workflow() as SouthstarWorkflowManifest & {
    tasks: Array<SouthstarWorkflowManifest["tasks"][number] & { profileOverride?: { harnessRef?: string } }>;
  };
  candidate.tasks[0]!.profileOverride = { harnessRef: "codex" };
  candidate.compiledFrom!.inputHash = "0".repeat(64);

  const materialized = materializeWorkflowTaskProfileOverrides(candidate);
  assert.equal(materialized.tasks[0]!.agentProfileRef, "profile__task__override");
  assert.equal(materialized.agentProfiles?.at(-1)?.harnessRef, "codex");

  const result = acceptWorkflowComposition({
    composition,
    compositionValidation: acceptedComposition,
    workflow: candidate,
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "workflow.compiledFrom.inputHash"));
});
