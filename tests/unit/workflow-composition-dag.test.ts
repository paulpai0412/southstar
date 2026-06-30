import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowCompositionPlanDisplay,
  buildWorkflowDagFromCompositionPlanText,
} from "../../web/lib/workflow/composition-plan-dag.ts";

test("buildWorkflowDagFromCompositionPlanText maps composer JSON into a renderable DAG", () => {
  const dag = buildWorkflowDagFromCompositionPlanText(JSON.stringify({
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Todo Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Build and verify the feature.",
    tasks: [
      {
        id: "task-understand",
        name: "Understand repo",
        responsibility: "Inspect repository.",
        dependsOn: [],
        templateSlotRef: "understand-repo",
        agentDefinitionRef: "agent.software-explorer",
        agentProfileRef: "profile.software-explorer-codex",
        instructionRefs: [],
        skillRefs: [],
        toolGrantRefs: [],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        evaluatorProfileRef: "evaluator.software-plan-quality",
        recoveryStrategyRefs: [],
        rationale: "Start with context.",
      },
      {
        id: "task-implement",
        name: "Implement feature",
        responsibility: "Change code.",
        dependsOn: ["task-understand"],
        templateSlotRef: "implement-feature",
        agentDefinitionRef: "agent.software-maker",
        agentProfileRef: "profile.software-maker-pi",
        instructionRefs: [],
        skillRefs: [],
        toolGrantRefs: [],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        evaluatorProfileRef: "evaluator.software-feature-quality",
        recoveryStrategyRefs: [],
        rationale: "Make the change.",
      },
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  }));

  assert.ok(dag);
  assert.equal(dag.templateId, "template.software-feature");
  assert.equal(dag.templateTitle, "Todo Workflow");
  assert.deepEqual(dag.edges, [{ from: "task-understand", to: "task-implement" }]);
  assert.deepEqual(dag.nodes.map((node) => [node.id, node.label, node.role, node.provider, node.level]), [
    ["task-understand", "Understand repo", "explorer", "codex", 0],
    ["task-implement", "Implement feature", "maker", "pi", 1],
  ]);
});

test("buildWorkflowCompositionPlanDisplay pretty prints compact composer JSON", () => {
  const display = buildWorkflowCompositionPlanDisplay(`{"schemaVersion":"southstar.workflow_composition_plan.v1","title":"Tiny","selectedWorkflowTemplateRef":"template.software-feature","tasks":[{"id":"task-a","name":"Task A","dependsOn":[],"agentDefinitionRef":"agent.software-maker","agentProfileRef":"profile.software-maker-pi"}]}`);

  assert.ok(display);
  assert.match(display.formattedText, /^```json\n{\n  "schemaVersion": "southstar\.workflow_composition_plan\.v1"/);
  assert.match(display.formattedText, /\n      "id": "task-a"/);
  assert.match(display.formattedText, /\n```\n?$/);
  assert.equal(display.dag.nodes[0]?.label, "Task A");
});
