import type {
  LibraryValidationResult,
  WorkflowTemplateEdge,
  WorkflowTemplatePayload,
} from "./types.ts";

const forbiddenContractRefs = new Set(["raw_transcript", "executor_stdout", "freeform_transcript"]);

export function validateWorkflowTemplateGraph(template: WorkflowTemplatePayload): LibraryValidationResult {
  const issues: Array<{ path: string; message: string; code?: string }> = [];
  if (!template?.flow) {
    return { ok: false, issues: [{ path: "flow", message: "flow is required", code: "flow_missing" }] };
  }

  const nodeIds = new Set(template.flow.nodes.map((node) => node.id));
  const incomingByNode = new Map<string, WorkflowTemplateEdge[]>();
  for (const node of template.flow.nodes) incomingByNode.set(node.id, []);

  for (const edge of template.flow.edges) {
    if (!nodeIds.has(edge.from)) {
      issues.push({ path: `flow.edges.${edge.id}.from`, message: `unknown from node ${edge.from}`, code: "edge_from_unknown" });
      continue;
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({ path: `flow.edges.${edge.id}.to`, message: `unknown to node ${edge.to}`, code: "edge_to_unknown" });
      continue;
    }
    incomingByNode.get(edge.to)?.push(edge);
  }

  // cycle detection using DFS
  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, []);
  for (const edge of template.flow.edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(nodeId: string, stack: string[]): void {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      const cycle = [...stack, nodeId].join(" -> ");
      issues.push({ path: "flow.edges", message: `cycle detected: ${cycle}`, code: "graph_cycle" });
      return;
    }
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      visit(next, [...stack, nodeId]);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const nodeId of nodeIds) visit(nodeId, []);

  for (const node of template.flow.nodes) {
    for (const contractRef of node.contractRefs) {
      if (forbiddenContractRefs.has(contractRef)) {
        issues.push({
          path: `flow.nodes.${node.id}.contractRefs`,
          message: `raw transcript-only dependency is forbidden: ${contractRef}`,
          code: "forbidden_contract_ref",
        });
      }
    }
    if (["agent_task", "validator_task"].includes(node.nodeType) && node.validatorRefs.length === 0) {
      issues.push({
        path: `flow.nodes.${node.id}.validatorRefs`,
        message: "validatorRefs must include at least one validator",
        code: "validator_missing",
      });
    }
  }

  if (template.stopConditionValidatorRefs.length === 0) {
    issues.push({
      path: "stopConditionValidatorRefs",
      message: "stopConditionValidatorRefs must not be empty",
      code: "stop_condition_missing",
    });
  }

  return { ok: issues.length === 0, issues };
}
