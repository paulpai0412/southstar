// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { randomUUID } from "node:crypto";
import type { PiPlannerClient } from "../planner/types.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendDraftEvent, createLibraryObject, listLibraryVersions } from "./store.ts";
import { validateWorkflowTemplateGraph } from "./template-validator.ts";
import type {
  LibraryValidationResult,
  RequirementSpec,
  WorkflowTemplatePayload,
} from "./types.ts";

export type TodoWebFeatureIssuePacket = {
  title: string;
  body: string;
  labels: string[];
  repoPath: string;
  acceptanceCriteria: string[];
};

export async function createWorkflowDesignDraftFromIssue(db: SouthstarDb, input: {
  issue: TodoWebFeatureIssuePacket;
  actorType: "llm" | "user" | "system";
  plannerClient: PiPlannerClient;
}): Promise<{
  draftId: string;
  requirementSpec: RequirementSpec;
  librarySearchTrace: {
    query: string;
    matchedDefinitions: Array<{ definitionRef: string; kind: string; score: number; reason: string }>;
    gaps: string[];
  };
  externalDiscoveryTrace: {
    source: "web";
    queries: string[];
    sources: Array<{ url: string; title: string; summary: string; proposedUse: string; risk: "low" | "medium" | "high" }>;
  };
  agentComposition: Array<{ roleRef: string; selectedAgentSpecRef: string; rationale: string; unresolvedRisks: string[] }>;
  validation: LibraryValidationResult;
}> {
  const requirementSpec: RequirementSpec = {
    summary: `${input.issue.title} (${input.issue.labels.join(", ")})`,
    requiredInputs: ["issueTitle", "issueBody", "repoPath", "acceptanceCriteria"],
    clarifiedInputs: {
      issueTitle: input.issue.title,
      issueBody: input.issue.body,
      repoPath: input.issue.repoPath,
      acceptanceCriteria: input.issue.acceptanceCriteria,
    },
    assumptions: ["todo-web fixture uses TypeScript browser app"],
    acceptanceCriteria: input.issue.acceptanceCriteria,
    nonGoals: ["runtime dependency changes"],
    riskNotes: ["must keep evidence and validators complete"],
  };

  const roleRefs = ["explorer", "planner", "implementer", "checker", "summarizer"] as const;
  const matchedDefinitions: Array<{ definitionRef: string; kind: string; score: number; reason: string }> = [];
  const agentComposition: Array<{ roleRef: string; selectedAgentSpecRef: string; rationale: string; unresolvedRisks: string[] }> = [];

  for (const roleRef of roleRefs) {
    const object = db.prepare(`
      select id, object_key
      from library_objects
      where object_kind = 'agent_spec' and object_key = ?
      limit 1
    `).get(`software-dev.agent.${roleRef}`) as { id: string; object_key: string } | undefined;
    if (!object) continue;
    const versions = listLibraryVersions(db, object.id);
    if (versions.length === 0) continue;
    const definitionRef = `${object.object_key}@${versions[versions.length - 1]!.versionId}`;
    matchedDefinitions.push({
      definitionRef,
      kind: "agent_spec",
      score: 0.93,
      reason: `matched approved ${roleRef} role from software-dev seed`,
    });
    agentComposition.push({
      roleRef,
      selectedAgentSpecRef: definitionRef,
      rationale: `${roleRef} is required in software-development workflow`,
      unresolvedRisks: [],
    });
  }

  const plannerPrompt = [
    "Design a software-development workflow template for this issue.",
    `title: ${input.issue.title}`,
    `body: ${input.issue.body}`,
    `repoPath: ${input.issue.repoPath}`,
    `acceptanceCriteria: ${input.issue.acceptanceCriteria.join(" | ")}`,
  ].join("\n");
  await input.plannerClient.generate(plannerPrompt);

  const templatePayload = buildWorkflowTemplatePayload({
    requirementSpec,
    agentComposition,
  });
  const validation = validateWorkflowTemplateGraph(templatePayload);

  const draftObject = createLibraryObject(db, {
    objectKey: `draft.workflow.${randomUUID()}`,
    objectKind: "workflow_template",
    status: "draft",
    state: {
      payload: templatePayload,
      validation,
      requirementSpec,
    },
    actorType: input.actorType,
  });

  appendDraftEvent(db, {
    objectId: draftObject.objectId,
    eventType: "draft.opened",
    status: validation.ok ? "valid" : "invalid",
    payload: {
      requirementSpec,
      matchedDefinitionCount: matchedDefinitions.length,
      actor: input.actorType,
    },
    actorType: input.actorType,
  });

  return {
    draftId: draftObject.objectId,
    requirementSpec,
    librarySearchTrace: {
      query: `${input.issue.title} ${input.issue.labels.join(" ")}`,
      matchedDefinitions,
      gaps: matchedDefinitions.length >= roleRefs.length ? [] : ["missing_role_agent_spec"],
    },
    externalDiscoveryTrace: {
      source: "web",
      queries: [],
      sources: [],
    },
    agentComposition,
    validation,
  };
}

function buildWorkflowTemplatePayload(input: {
  requirementSpec: RequirementSpec;
  agentComposition: Array<{ roleRef: string; selectedAgentSpecRef: string }>;
}): WorkflowTemplatePayload {
  const agentRefByRole = new Map(input.agentComposition.map((entry) => [entry.roleRef, entry.selectedAgentSpecRef]));
  return {
    schemaVersion: "southstar.library.workflow_template.v1",
    templateType: "exact",
    inputContractRef: "software-dev.contract.issue-input",
    flow: {
      primaryPattern: "maker_checker",
      secondaryPatterns: ["human_gate"],
      nodes: [
        createNode("explorer", agentRefByRole),
        createNode("planner", agentRefByRole),
        createNode("implementer", agentRefByRole),
        createNode("checker", agentRefByRole),
        createNode("summarizer", agentRefByRole),
      ],
      edges: [
        { id: "explorer-to-planner", from: "explorer", to: "planner", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.issue-input"] },
        { id: "planner-to-implementer", from: "planner", to: "implementer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true },
        { id: "implementer-to-checker", from: "implementer", to: "checker", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.verification-artifact"], workspaceStateRequired: true },
        { id: "checker-to-summarizer", from: "checker", to: "summarizer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.completion-artifact"] },
      ],
      recovery: { onValidatorFailure: "request_workflow_revision", maxAttempts: 2 },
    },
    outputContractRefs: ["software-dev.contract.completion-artifact"],
    evidenceContractRefs: ["software-dev.contract.implementation-artifact", "software-dev.contract.verification-artifact"],
    stopConditionValidatorRefs: ["software-dev.validator.schema-evidence-policy"],
    lifecycle: {
      status: "draft",
      validatedByRunIds: [],
      failureEvidenceRefs: [],
    },
    reuse: {
      signature: "todo-web feature issue software workflow",
      tags: ["software", "todo-web"],
      requiredInputs: ["issueTitle", "issueBody", "repoPath", "acceptanceCriteria"],
      assumptionDefaults: {},
      clarificationPolicy: {
        askOnlyWhenMissingRequiredInput: true,
        askWhenSimilarityBelow: 0.85,
        askWhenRiskAbove: "low",
      },
      requirementSpecSnapshot: input.requirementSpec,
    },
  };
}

function createNode(
  roleRef: string,
  agentRefByRole: Map<string, string>,
): WorkflowTemplatePayload["flow"]["nodes"][number] {
  return {
    id: roleRef,
    nodeType: "agent_task",
    name: `${roleRef[0]!.toUpperCase()}${roleRef.slice(1)}`,
    roleRef,
    agentSpecRef: agentRefByRole.get(roleRef) ?? `software-dev.agent.${roleRef}`,
    contractRefs: roleRef === "implementer"
      ? ["software-dev.contract.implementation-artifact"]
      : roleRef === "checker"
      ? ["software-dev.contract.verification-artifact"]
      : roleRef === "summarizer"
      ? ["software-dev.contract.completion-artifact"]
      : ["software-dev.contract.issue-input"],
    validatorRefs: ["software-dev.validator.schema-evidence-policy"],
    capabilityRefs: roleRef === "checker"
      ? ["software-dev.capability.browser-ux-verification"]
      : ["software-dev.capability.repo-read-write"],
    mcpCapabilityRefs: [],
    workspacePolicyRef: "software-dev.policy.safe-workspace-tork",
  };
}
