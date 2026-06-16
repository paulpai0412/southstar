import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendDraftEvent, getLibraryObject, updateLibraryObjectState } from "./store.ts";
import { validateWorkflowTemplateGraph } from "./template-validator.ts";
import type {
  LibraryValidationResult,
  WorkflowTemplateEdge,
  WorkflowTemplateNode,
  WorkflowTemplatePatch,
  WorkflowTemplatePayload,
} from "./types.ts";

export function applyWorkflowTemplatePatch(
  db: SouthstarDb,
  patch: WorkflowTemplatePatch,
): { draftId: string; validation: LibraryValidationResult } {
  const object = getLibraryObject(db, patch.baseDraftId);
  if (object.objectKind !== "workflow_template") {
    throw new Error(`workflow template patch requires object_kind workflow_template, got ${object.objectKind}`);
  }

  const basePayload = normalizeTemplatePayload(object.state);
  const nextPayload = applyOperations(basePayload, patch);
  const validation = validateWorkflowTemplateGraph(nextPayload);

  const nextState = {
    ...(object.state.payload ? object.state : {}),
    payload: nextPayload,
    validation,
    lastPatchRationale: patch.rationale,
    lastPatchActor: patch.actor,
  };

  updateLibraryObjectState(db, {
    objectId: object.objectId,
    status: validation.ok ? object.status : "draft",
    headVersionId: object.headVersionId,
    state: nextState,
  });

  appendDraftEvent(db, {
    objectId: object.objectId,
    eventType: "draft.patch_applied",
    status: validation.ok ? "valid" : "invalid",
    payload: {
      rationale: patch.rationale,
      actor: patch.actor,
      operations: patch.operations,
      validation,
    },
    actorType: patch.actor,
  });

  return { draftId: object.objectId, validation };
}

function normalizeTemplatePayload(state: Record<string, unknown>): WorkflowTemplatePayload {
  const payload = (state.payload ?? state) as WorkflowTemplatePayload;
  if (!payload?.flow || !Array.isArray(payload.flow.nodes) || !Array.isArray(payload.flow.edges)) {
    throw new Error("workflow template draft state must contain flow.nodes and flow.edges arrays");
  }
  if (!Array.isArray(payload.stopConditionValidatorRefs)) {
    throw new Error("workflow template draft payload requires stopConditionValidatorRefs");
  }
  return deepClone(payload);
}

function applyOperations(template: WorkflowTemplatePayload, patch: WorkflowTemplatePatch): WorkflowTemplatePayload {
  for (const operation of patch.operations) {
    switch (operation.op) {
      case "add-node":
        addNode(template.flow.nodes, operation.node);
        break;
      case "remove-node":
        removeNode(template, operation.nodeId);
        break;
      case "update-node":
        updateNode(template.flow.nodes, operation.nodeId, operation.patch);
        break;
      case "add-edge":
        addEdge(template.flow.edges, operation.edge);
        break;
      case "remove-edge":
        removeEdge(template.flow.edges, operation.edgeId);
        break;
      case "replace-agent":
        updateNode(template.flow.nodes, operation.nodeId, { agentSpecRef: operation.agentSpecRef });
        break;
      case "set-contracts":
        updateNode(template.flow.nodes, operation.nodeId, { contractRefs: operation.contractRefs });
        break;
      case "set-validators":
        updateNode(template.flow.nodes, operation.nodeId, { validatorRefs: operation.validatorRefs });
        break;
      default: {
        const exhaustive: never = operation;
        throw new Error(`unsupported patch op ${(exhaustive as any).op}`);
      }
    }
  }
  return template;
}

function addNode(nodes: WorkflowTemplateNode[], node: WorkflowTemplateNode): void {
  if (nodes.some((candidate) => candidate.id === node.id)) {
    throw new Error(`duplicate node id: ${node.id}`);
  }
  nodes.push(node);
}

function removeNode(template: WorkflowTemplatePayload, nodeId: string): void {
  const before = template.flow.nodes.length;
  template.flow.nodes = template.flow.nodes.filter((node) => node.id !== nodeId);
  if (before === template.flow.nodes.length) {
    throw new Error(`cannot remove missing node: ${nodeId}`);
  }
  template.flow.edges = template.flow.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
}

function updateNode(nodes: WorkflowTemplateNode[], nodeId: string, nodePatch: Record<string, unknown>): void {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`cannot update missing node: ${nodeId}`);
  Object.assign(node, nodePatch);
}

function addEdge(edges: WorkflowTemplateEdge[], edge: WorkflowTemplateEdge): void {
  if (edges.some((candidate) => candidate.id === edge.id)) {
    throw new Error(`duplicate edge id: ${edge.id}`);
  }
  edges.push(edge);
}

function removeEdge(edges: WorkflowTemplateEdge[], edgeId: string): void {
  const before = edges.length;
  const next = edges.filter((edge) => edge.id !== edgeId);
  if (before === next.length) throw new Error(`cannot remove missing edge: ${edgeId}`);
  edges.splice(0, edges.length, ...next);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
