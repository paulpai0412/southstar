import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { insertRuntimeResourceIfAbsentPg } from "../stores/postgres-runtime-store.ts";
import type { GoalRequirementDraftV1 } from "./goal-requirement-draft.ts";

export type UiInteractionElementType =
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "text"
  | "heading"
  | "list"
  | "card"
  | "form"
  | "table"
  | "image"
  | "link"
  | "status";

export type UiInteractionContractStatus = "draft" | "confirmed" | "superseded";

export type UiInteractionContractScreenV1 = {
  id: string;
  title: string;
  purpose: string;
  layout: {
    regions: Array<{
      id: string;
      role: "header" | "navigation" | "main" | "aside" | "footer" | "dialog" | "status";
      position: "top" | "left" | "center" | "right" | "bottom" | "overlay";
      childRefs: string[];
    }>;
  };
  elements: Array<{
    id: string;
    type: UiInteractionElementType;
    label?: string;
    visibleInStates: string[];
    enabledInStates: string[];
  }>;
  states: string[];
  actions: Array<{
    id: string;
    triggerElementId: string;
    fromState: string;
    toState: string;
    targetScreenId?: string;
    expectedEffect: string;
  }>;
  responsiveRules: string[];
  accessibilityRules: string[];
};

export type UiInteractionContractV1 = {
  schemaVersion: "southstar.ui_interaction_contract.v1";
  id: string;
  revision: number;
  parentRevision?: number;
  status: UiInteractionContractStatus;
  requirementIds: string[];
  screens: UiInteractionContractScreenV1[];
  flows: Array<{ id: string; steps: string[]; successOutcome: string }>;
  criterionBindings: Array<{
    criterionId: string;
    screenIds: string[];
    elementIds: string[];
    actionIds: string[];
  }>;
  contractHash: string;
};

export type UiInteractionContractInputV1 = Pick<
  UiInteractionContractV1,
  "requirementIds" | "screens" | "flows" | "criterionBindings"
>;

export type UiInteractionContractIssueCode =
  | "invalid_contract"
  | "invalid_schema_version"
  | "invalid_contract_id"
  | "invalid_revision"
  | "invalid_parent_revision"
  | "invalid_status"
  | "unknown_requirement"
  | "unlinked_requirement"
  | "duplicate_id"
  | "invalid_screen"
  | "invalid_region"
  | "invalid_element"
  | "invalid_element_type"
  | "unknown_region_child"
  | "unknown_element_state"
  | "enabled_while_hidden"
  | "invalid_action"
  | "unknown_action_element"
  | "unknown_transition_state"
  | "unknown_target_screen"
  | "invalid_flow"
  | "unknown_flow_action"
  | "unknown_criterion"
  | "unknown_binding_screen"
  | "unknown_binding_element"
  | "unknown_binding_action"
  | "missing_criterion_binding"
  | "invalid_contract_hash"
  | "contract_hash_mismatch";

export type UiInteractionContractIssue = {
  code: UiInteractionContractIssueCode;
  path: string;
  message: string;
};

export type UiInteractionContractRevisionOperation =
  | { kind: "replace"; contract: UiInteractionContractInputV1 }
  | {
      kind: "update_element";
      screenId: string;
      elementId: string;
      patch: Partial<Pick<UiInteractionContractScreenV1["elements"][number], "type" | "label" | "visibleInStates" | "enabledInStates">>;
    }
  | {
      kind: "update_action";
      screenId: string;
      actionId: string;
      patch: Partial<Pick<UiInteractionContractScreenV1["actions"][number], "triggerElementId" | "fromState" | "toState" | "targetScreenId" | "expectedEffect">>;
    }
  | {
      kind: "update_screen";
      screenId: string;
      patch: Partial<Pick<UiInteractionContractScreenV1, "title" | "purpose" | "responsiveRules" | "accessibilityRules">>;
    }
  | { kind: "confirm" };

type ContractWithoutHash = Omit<UiInteractionContractV1, "contractHash">;

const ELEMENT_TYPES = new Set<UiInteractionElementType>([
  "button", "input", "textarea", "select", "checkbox", "text", "heading", "list", "card", "form", "table", "image", "link", "status",
]);
const REGION_ROLES = new Set(["header", "navigation", "main", "aside", "footer", "dialog", "status"]);
const REGION_POSITIONS = new Set(["top", "left", "center", "right", "bottom", "overlay"]);
const STATUSES = new Set<UiInteractionContractStatus>(["draft", "confirmed", "superseded"]);

export function uiInteractionContractHash(contract: ContractWithoutHash): string {
  return contentHashForPayload(contract);
}

/**
 * Materialize host-owned identity, lineage and hash around semantic screen data.
 * The id must be an interactionContractRef already declared by an owning
 * requirement, unless it can be inferred unambiguously from those refs.
 */
export function finalizeUiInteractionContract(
  input: UiInteractionContractInputV1,
  requirementDraft: GoalRequirementDraftV1,
  host: { id?: string; revision?: number; parentRevision?: number; status?: UiInteractionContractStatus } = {},
): UiInteractionContractV1 {
  const id = host.id ?? inferContractId(input.requirementIds, requirementDraft);
  const withoutHash: ContractWithoutHash = {
    schemaVersion: "southstar.ui_interaction_contract.v1",
    id,
    revision: host.revision ?? 1,
    ...(host.parentRevision !== undefined ? { parentRevision: host.parentRevision } : {}),
    status: host.status ?? "draft",
    requirementIds: [...input.requirementIds],
    screens: structuredClone(input.screens),
    flows: structuredClone(input.flows),
    criterionBindings: structuredClone(input.criterionBindings),
  };
  const contract = { ...withoutHash, contractHash: uiInteractionContractHash(withoutHash) };
  const issues = validateUiInteractionContract(contract, requirementDraft);
  if (issues.length > 0) {
    throw new Error(`invalid UI interaction contract: ${issues.map((entry) => `${entry.code} at ${entry.path}`).join("; ")}`);
  }
  return contract;
}

export function reviseUiInteractionContract(
  current: UiInteractionContractV1,
  operation: UiInteractionContractRevisionOperation,
  requirementDraft: GoalRequirementDraftV1,
): UiInteractionContractV1 {
  const currentIssues = validateUiInteractionContract(current, requirementDraft);
  if (currentIssues.length > 0) {
    throw new Error(`ui_interaction_contract_invalid: ${JSON.stringify(currentIssues)}`);
  }
  if (current.status === "superseded") throw new Error(`ui_interaction_contract_superseded: ${current.id}`);
  const semantic: UiInteractionContractInputV1 = {
    requirementIds: [...current.requirementIds],
    screens: structuredClone(current.screens),
    flows: structuredClone(current.flows),
    criterionBindings: structuredClone(current.criterionBindings),
  };
  let status: UiInteractionContractStatus = current.status === "confirmed" ? "draft" : current.status;

  switch (operation.kind) {
    case "replace":
      semantic.requirementIds = [...operation.contract.requirementIds];
      semantic.screens = structuredClone(operation.contract.screens);
      semantic.flows = structuredClone(operation.contract.flows);
      semantic.criterionBindings = structuredClone(operation.contract.criterionBindings);
      status = "draft";
      break;
    case "update_element": {
      assertOnlyKeys(operation.patch, ["type", "label", "visibleInStates", "enabledInStates"], "element patch");
      const screen = requiredScreen(semantic.screens, operation.screenId);
      const index = screen.elements.findIndex((entry) => entry.id === operation.elementId);
      if (index < 0) throw new Error(`unknown UI element: ${operation.elementId}`);
      screen.elements[index] = { ...screen.elements[index]!, ...structuredClone(operation.patch) };
      status = "draft";
      break;
    }
    case "update_action": {
      assertOnlyKeys(operation.patch, ["triggerElementId", "fromState", "toState", "targetScreenId", "expectedEffect"], "action patch");
      const screen = requiredScreen(semantic.screens, operation.screenId);
      const index = screen.actions.findIndex((entry) => entry.id === operation.actionId);
      if (index < 0) throw new Error(`unknown UI action: ${operation.actionId}`);
      const next = { ...screen.actions[index]!, ...structuredClone(operation.patch) };
      if (operation.patch.targetScreenId === undefined && "targetScreenId" in operation.patch) delete next.targetScreenId;
      screen.actions[index] = next;
      status = "draft";
      break;
    }
    case "update_screen": {
      assertOnlyKeys(operation.patch, ["title", "purpose", "responsiveRules", "accessibilityRules"], "screen patch");
      const screen = requiredScreen(semantic.screens, operation.screenId);
      Object.assign(screen, structuredClone(operation.patch));
      status = "draft";
      break;
    }
    case "confirm":
      status = "confirmed";
      break;
    default:
      assertNever(operation);
  }

  return finalizeUiInteractionContract(semantic, requirementDraft, {
    id: current.id,
    revision: current.revision + 1,
    parentRevision: current.revision,
    status,
  });
}

export function validateUiInteractionContract(
  contract: UiInteractionContractV1,
  requirementDraft: GoalRequirementDraftV1,
): UiInteractionContractIssue[] {
  const issues: UiInteractionContractIssue[] = [];
  if (!record(contract)) return [issue("invalid_contract", "contract", "UI interaction contract must be an object")];
  if (contract.schemaVersion !== "southstar.ui_interaction_contract.v1") issues.push(issue("invalid_schema_version", "schemaVersion", "unsupported UI interaction contract schema version"));
  if (!nonEmpty(contract.id)) issues.push(issue("invalid_contract_id", "id", "contract id must be non-empty"));
  if (!Number.isInteger(contract.revision) || contract.revision < 1) issues.push(issue("invalid_revision", "revision", "revision must be a positive integer"));
  if (contract.parentRevision !== undefined && (!Number.isInteger(contract.parentRevision) || contract.parentRevision < 1 || contract.parentRevision >= contract.revision)) {
    issues.push(issue("invalid_parent_revision", "parentRevision", "parentRevision must be an earlier positive revision"));
  }
  if (!STATUSES.has(contract.status)) issues.push(issue("invalid_status", "status", "unsupported contract status"));

  const activeRequirements = new Map(requirementDraft.requirements.filter((entry) => entry.status !== "superseded").map((entry) => [entry.id, entry]));
  if (!stringArray(contract.requirementIds) || contract.requirementIds.length === 0) issues.push(issue("unknown_requirement", "requirementIds", "at least one owning requirement is required"));
  const requirementIds = new Set<string>();
  for (const [index, requirementId] of (Array.isArray(contract.requirementIds) ? contract.requirementIds : []).entries()) {
    if (requirementIds.has(requirementId)) issues.push(issue("duplicate_id", `requirementIds.${index}`, `duplicate requirement id: ${requirementId}`));
    requirementIds.add(requirementId);
    const requirement = activeRequirements.get(requirementId);
    if (!requirement) issues.push(issue("unknown_requirement", `requirementIds.${index}`, `unknown active requirement: ${requirementId}`));
    else if (!requirement.interactionContractRefs.includes(contract.id)) issues.push(issue("unlinked_requirement", `requirementIds.${index}`, `requirement does not reference contract: ${contract.id}`));
  }

  const screenIds = new Set<string>();
  const globalElementIds = new Set<string>();
  const globalActionIds = new Set<string>();
  const screens = Array.isArray(contract.screens) ? contract.screens : [];
  if (screens.length === 0) issues.push(issue("invalid_screen", "screens", "at least one screen is required"));
  for (const [screenIndex, screen] of screens.entries()) {
    const screenPath = `screens.${screenIndex}`;
    if (!record(screen) || !nonEmpty(screen.id) || !nonEmpty(screen.title) || !nonEmpty(screen.purpose)) {
      issues.push(issue("invalid_screen", screenPath, "screen needs id, title, and purpose"));
      continue;
    }
    unique(screenIds, screen.id, `${screenPath}.id`, issues);
    const states = Array.isArray(screen.states) ? screen.states : [];
    if (!stringArray(states) || states.length === 0) issues.push(issue("invalid_screen", `${screenPath}.states`, "screen states must contain non-empty values"));
    const stateSet = new Set<string>();
    states.forEach((state, index) => unique(stateSet, state, `${screenPath}.states.${index}`, issues));

    const elements = Array.isArray(screen.elements) ? screen.elements : [];
    const screenElementIds = new Set<string>();
    for (const [elementIndex, element] of elements.entries()) {
      const path = `${screenPath}.elements.${elementIndex}`;
      if (!record(element) || !nonEmpty(element.id) || !stringArray(element.visibleInStates) || !stringArray(element.enabledInStates)) {
        issues.push(issue("invalid_element", path, "element needs id and valid visible/enabled state lists"));
        continue;
      }
      unique(screenElementIds, element.id, `${path}.id`, issues);
      unique(globalElementIds, element.id, `${path}.id`, issues);
      if (!ELEMENT_TYPES.has(element.type)) issues.push(issue("invalid_element_type", `${path}.type`, `unsupported element type: ${String(element.type)}`));
      for (const state of [...element.visibleInStates, ...element.enabledInStates]) {
        if (!stateSet.has(state)) issues.push(issue("unknown_element_state", path, `element references unknown state: ${state}`));
      }
      for (const state of element.enabledInStates) {
        if (!element.visibleInStates.includes(state)) issues.push(issue("enabled_while_hidden", `${path}.enabledInStates`, `enabled state must also be visible: ${state}`));
      }
    }

    const regions = record(screen.layout) && Array.isArray(screen.layout.regions) ? screen.layout.regions : [];
    if (regions.length === 0) issues.push(issue("invalid_region", `${screenPath}.layout.regions`, "screen needs at least one layout region"));
    const regionIds = new Set<string>();
    for (const [regionIndex, region] of regions.entries()) {
      const path = `${screenPath}.layout.regions.${regionIndex}`;
      if (!record(region) || !nonEmpty(region.id) || !REGION_ROLES.has(region.role) || !REGION_POSITIONS.has(region.position) || !stringArray(region.childRefs)) {
        issues.push(issue("invalid_region", path, "region needs a known role, position, and child refs"));
        continue;
      }
      unique(regionIds, region.id, `${path}.id`, issues);
      for (const childRef of region.childRefs) if (!screenElementIds.has(childRef)) issues.push(issue("unknown_region_child", `${path}.childRefs`, `unknown element: ${childRef}`));
    }

    const actions = Array.isArray(screen.actions) ? screen.actions : [];
    for (const [actionIndex, action] of actions.entries()) {
      const path = `${screenPath}.actions.${actionIndex}`;
      if (!record(action) || !nonEmpty(action.id) || !nonEmpty(action.triggerElementId) || !nonEmpty(action.fromState) || !nonEmpty(action.toState) || !nonEmpty(action.expectedEffect)) {
        issues.push(issue("invalid_action", path, "action needs id, trigger, transition, and expected effect"));
        continue;
      }
      unique(globalActionIds, action.id, `${path}.id`, issues);
      if (!screenElementIds.has(action.triggerElementId)) issues.push(issue("unknown_action_element", `${path}.triggerElementId`, `unknown trigger element: ${action.triggerElementId}`));
      if (!stateSet.has(action.fromState)) issues.push(issue("unknown_transition_state", `${path}.fromState`, `unknown state: ${action.fromState}`));
      if (!stateSet.has(action.toState)) issues.push(issue("unknown_transition_state", `${path}.toState`, `unknown state: ${action.toState}`));
    }
  }
  for (const [screenIndex, screen] of screens.entries()) {
    for (const [actionIndex, action] of (Array.isArray(screen.actions) ? screen.actions : []).entries()) {
      if (action.targetScreenId !== undefined && !screenIds.has(action.targetScreenId)) {
        issues.push(issue("unknown_target_screen", `screens.${screenIndex}.actions.${actionIndex}.targetScreenId`, `unknown target screen: ${action.targetScreenId}`));
      }
    }
  }

  const flowIds = new Set<string>();
  for (const [flowIndex, flow] of (Array.isArray(contract.flows) ? contract.flows : []).entries()) {
    const path = `flows.${flowIndex}`;
    if (!record(flow) || !nonEmpty(flow.id) || !stringArray(flow.steps) || flow.steps.length === 0 || !nonEmpty(flow.successOutcome)) {
      issues.push(issue("invalid_flow", path, "flow needs id, action steps, and success outcome"));
      continue;
    }
    unique(flowIds, flow.id, `${path}.id`, issues);
    for (const actionId of flow.steps) if (!globalActionIds.has(actionId)) issues.push(issue("unknown_flow_action", `${path}.steps`, `unknown action: ${actionId}`));
  }

  const knownCriteria = new Set([...activeRequirements.values()].flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => criterion.id)));
  const boundCriteria = new Set<string>();
  for (const [bindingIndex, binding] of (Array.isArray(contract.criterionBindings) ? contract.criterionBindings : []).entries()) {
    const path = `criterionBindings.${bindingIndex}`;
    if (!record(binding) || !nonEmpty(binding.criterionId) || !stringArray(binding.screenIds) || !stringArray(binding.elementIds) || !stringArray(binding.actionIds)) {
      issues.push(issue("unknown_criterion", path, "criterion binding is malformed"));
      continue;
    }
    unique(boundCriteria, binding.criterionId, `${path}.criterionId`, issues);
    if (!knownCriteria.has(binding.criterionId)) issues.push(issue("unknown_criterion", `${path}.criterionId`, `unknown criterion: ${binding.criterionId}`));
    for (const id of binding.screenIds) if (!screenIds.has(id)) issues.push(issue("unknown_binding_screen", `${path}.screenIds`, `unknown screen: ${id}`));
    for (const id of binding.elementIds) if (!globalElementIds.has(id)) issues.push(issue("unknown_binding_element", `${path}.elementIds`, `unknown element: ${id}`));
    for (const id of binding.actionIds) if (!globalActionIds.has(id)) issues.push(issue("unknown_binding_action", `${path}.actionIds`, `unknown action: ${id}`));
  }
  for (const requirementId of requirementIds) {
    const requirement = activeRequirements.get(requirementId);
    if (!requirement) continue;
    for (const criterion of requirement.acceptanceCriteria) {
      if (!boundCriteria.has(criterion.id)) issues.push(issue("missing_criterion_binding", "criterionBindings", `criterion is not bound to UI evidence: ${criterion.id}`));
    }
  }

  if (typeof contract.contractHash !== "string" || !/^[a-f0-9]{64}$/.test(contract.contractHash)) {
    issues.push(issue("invalid_contract_hash", "contractHash", "contractHash must be a lowercase SHA-256 hex hash"));
  } else {
    const { contractHash: _hash, ...withoutHash } = contract;
    if (uiInteractionContractHash(withoutHash) !== contract.contractHash) issues.push(issue("contract_hash_mismatch", "contractHash", "contractHash does not match canonical contract content"));
  }
  return issues;
}

export async function persistUiInteractionContractRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; contract: UiInteractionContractV1; requirementDraft: GoalRequirementDraftV1; actor?: string },
): Promise<void> {
  const issues = validateUiInteractionContract(input.contract, input.requirementDraft);
  if (issues.length > 0) throw new Error(`invalid UI interaction contract: ${issues.map((entry) => entry.code).join(", ")}`);
  const resourceKey = `${input.draftId}:${input.contract.id}:revision:${input.contract.revision}`;
  const existing = await insertRuntimeResourceIfAbsentPg(db, {
    resourceType: "ui_interaction_contract_revision",
    resourceKey,
    scope: "planner",
    status: input.contract.status,
    title: `UI Interaction Contract ${input.contract.id} revision ${input.contract.revision}`,
    payload: { draftId: input.draftId, ...input.contract },
    summary: {
      draftId: input.draftId,
      contractId: input.contract.id,
      revision: input.contract.revision,
      parentRevision: input.contract.parentRevision,
      contractHash: input.contract.contractHash,
      status: input.contract.status,
      requirementIds: input.contract.requirementIds,
      ...(input.actor ? { actor: input.actor } : {}),
    },
  });
  const stored = existing.payload as Record<string, unknown>;
  if (stored.contractHash !== input.contract.contractHash) throw new Error(`ui_interaction_contract_revision_conflict: ${resourceKey}`);
}

function inferContractId(requirementIds: string[], draft: GoalRequirementDraftV1): string {
  const refs = new Set(
    draft.requirements
      .filter((entry) => entry.status !== "superseded" && requirementIds.includes(entry.id))
      .flatMap((entry) => entry.interactionContractRefs),
  );
  if (refs.size !== 1) throw new Error("UI interaction contract id must be supplied when requirement refs are not unambiguous");
  return [...refs][0]!;
}

function requiredScreen(screens: UiInteractionContractScreenV1[], screenId: string): UiInteractionContractScreenV1 {
  const screen = screens.find((entry) => entry.id === screenId);
  if (!screen) throw new Error(`unknown UI screen: ${screenId}`);
  return screen;
}

function assertOnlyKeys(value: object, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function unique(set: Set<string>, value: string, path: string, issues: UiInteractionContractIssue[]): void {
  if (set.has(value)) issues.push(issue("duplicate_id", path, `duplicate id: ${value}`));
  set.add(value);
}

function issue(code: UiInteractionContractIssueCode, path: string, message: string): UiInteractionContractIssue {
  return { code, path, message };
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}

function assertNever(value: never): never {
  throw new Error(`unsupported UI interaction contract operation: ${JSON.stringify(value)}`);
}
