import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import { contentHashForPayload } from "./canonical-json.ts";
import { findLibraryObjectByKey, getLibraryVersion } from "./store.ts";
import type { TodoWebFeatureIssuePacket } from "./designer.ts";
import type { WorkflowTemplatePayload } from "./types.ts";

export function compileTemplateVersionToManifest(db: SouthstarDb, input: {
  templateVersionId: string;
  issue: TodoWebFeatureIssuePacket;
  runInputs: Record<string, unknown>;
  compilerVersion: string;
}): SouthstarWorkflowManifest {
  const version = getLibraryVersion(db, input.templateVersionId);
  if (!version) throw new Error(`unknown template version: ${input.templateVersionId}`);
  if (version.definitionKind !== "workflow_template") {
    throw new Error(`template version ${input.templateVersionId} must be workflow_template`);
  }

  const template = version.payload as WorkflowTemplatePayload;
  const taskNodes = template.flow.nodes.filter((node) => node.nodeType === "agent_task");
  if (taskNodes.length === 0) {
    throw new Error(`template ${input.templateVersionId} has no executable agent_task nodes`);
  }

  const tasks: WorkflowTaskDefinition[] = taskNodes.map((node) => {
    const dependsOn = template.flow.edges
      .filter((edge) => edge.to === node.id)
      .map((edge) => edge.from)
      .filter((from) => taskNodes.some((candidate) => candidate.id === from));

    const profile = profileForNode(node);

    return {
      id: node.id,
      name: node.name,
      domain: "software",
      roleRef: profile.roleRef,
      agentProfileRef: profile.agentProfileRef,
      providerRef: "pi",
      model: "pi-agent-default",
      dependsOn,
      promptInputs: {
        issueTitle: input.issue.title,
        issueBody: input.issue.body,
        acceptanceCriteria: input.issue.acceptanceCriteria,
        repoPath: input.issue.repoPath,
      },
      requiredArtifactRefs: [profile.requiredArtifactRef],
      evaluatorPipelineRef: profile.evaluatorPipelineRef,
      stopConditionRefs: profile.stopConditionRefs,
      recoveryStrategyRefs: ["request-workflow-revision"],
      contextPolicyRef: "software-context-default",
      sessionPolicyRef: "software-session-default",
      workspacePolicyRef: "software-git-workspace",
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [{ source: input.issue.repoPath, target: "/workspace/repo", readonly: false }],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: {
        validator: "schema-evaluator-v1",
        maxRepairAttempts: 2,
      },
      skillRefs: skillRefsForNode(node),
      memoryScopeRefs: ["software", "project"],
      mcpGrantRefs: [],
      subagents: [{
        id: `${node.id}-worker`,
        harnessId: "pi",
        prompt: renderTaskPrompt(profile, input.issue),
        requiredArtifacts: [profile.requiredArtifactRef],
      }],
    };
  });

  const inputHash = contentHashForPayload({ issue: input.issue, runInputs: input.runInputs });
  const skillRefs = [...new Set(taskNodes.flatMap((node) => skillRefsForNode(node)))];
  const libraryVersionRefs = [
    input.templateVersionId,
    ...taskNodes
      .map((node) => node.agentSpecRef)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
    ...collectSkillVersionRefs(db, skillRefs),
  ];

  const agentProfiles = [
    ...softwareDomainPack.agentProfiles
      .filter((profile) => profile.provider === "pi")
      .map((profile) => ({ ...profile, skillRefs: [] })),
    {
      id: "software-summarizer-pi",
      name: "Software Summarizer Pi",
      provider: "pi",
      model: "pi-agent-default",
      harnessRef: "pi",
      agentsMdRefs: [],
      promptTemplateRef: "software-summarizer",
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopes: ["software", "project"],
      contextPolicyRef: "software-context-summary",
      sessionPolicyRef: "software-session-default",
      toolPolicy: { allowedTools: ["read", "search", "shell"], deniedTools: ["network-write"], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxWallTimeSeconds: 180 },
    },
  ];

  return {
    schemaVersion: "southstar.v2",
    workflowId: `wf-${input.templateVersionId}`,
    title: `Design Library Workflow: ${input.issue.title}`,
    goalPrompt: [
      input.issue.title,
      input.issue.body,
      `repoPath=${input.issue.repoPath}`,
      `acceptance=${input.issue.acceptanceCriteria.join(" | ")}`,
    ].join("\n"),
    domain: "software",
    intent: "implement_feature",
    roles: softwareDomainPack.roles,
    agentProfiles,
    artifactContracts: softwareDomainPack.artifactContracts,
    evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
    contextPolicies: softwareDomainPack.contextPolicies,
    sessionPolicies: softwareDomainPack.sessionPolicies,
    memoryPolicies: softwareDomainPack.memoryPolicies,
    workspacePolicies: softwareDomainPack.workspacePolicies,
    tasks,
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{
      id: "schema-evaluator-v1",
      kind: "schema",
      artifactTypes: ["implementation-plan", "implementation-report", "verification-report", "completion-report"],
      requiredFields: ["summary"],
    }],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    compiledFrom: {
      templateDefinitionId: version.objectId,
      templateVersionId: version.versionId,
      compilerVersion: input.compilerVersion,
      inputHash,
      libraryVersionRefs,
    },
  };
}

function profileForNode(node: WorkflowTemplatePayload["flow"]["nodes"][number]): {
  roleRef: "explorer" | "maker" | "checker" | "summarizer";
  agentProfileRef: string;
  requiredArtifactRef: "implementation_plan" | "implementation_report" | "verification_report" | "completion_report";
  evaluatorPipelineRef: "software-plan-quality" | "software-feature-quality" | "software-verification-quality" | "software-completion-quality";
  stopConditionRefs: string[];
} {
  const id = `${node.id} ${node.name} ${node.roleRef ?? ""}`.toLowerCase();
  if (id.includes("summar")) {
    return {
      roleRef: "summarizer",
      agentProfileRef: "software-summarizer-pi",
      requiredArtifactRef: "completion_report",
      evaluatorPipelineRef: "software-completion-quality",
      stopConditionRefs: ["software-feature-complete"],
    };
  }
  if (id.includes("check") || id.includes("verify") || id.includes("browser")) {
    return {
      roleRef: "checker",
      agentProfileRef: "software-checker-pi",
      requiredArtifactRef: "verification_report",
      evaluatorPipelineRef: "software-verification-quality",
      stopConditionRefs: ["software-feature-complete"],
    };
  }
  if (id.includes("plan") || id.includes("explore")) {
    return {
      roleRef: "explorer",
      agentProfileRef: "software-explorer-pi",
      requiredArtifactRef: "implementation_plan",
      evaluatorPipelineRef: "software-plan-quality",
      stopConditionRefs: [],
    };
  }
  return {
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    requiredArtifactRef: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
    stopConditionRefs: [],
  };
}

function skillRefsForNode(node: WorkflowTemplatePayload["flow"]["nodes"][number]): string[] {
  const id = `${node.id} ${node.name} ${node.roleRef ?? ""}`.toLowerCase();
  if (id.includes("summar")) return ["software-dev.skill.summarizer-completion"];
  if (id.includes("check") || id.includes("verify") || id.includes("browser")) return ["software-dev.skill.checker-verification"];
  if (id.includes("planner") || id.startsWith("planner ") || id.includes(" plan ")) return ["software-dev.skill.planner-planning"];
  if (id.includes("explorer") || id.includes("explore")) return ["software-dev.skill.explorer-context"];
  return ["software-dev.skill.implementer-implementation"];
}

function collectSkillVersionRefs(db: SouthstarDb, skillRefs: string[]): string[] {
  const refs: string[] = [];
  const visited = new Set<string>();

  const visit = (skillRef: string) => {
    if (visited.has(skillRef)) return;
    visited.add(skillRef);

    const object = findLibraryObjectByKey(db, skillRef);
    if (!object?.headVersionId) return;
    refs.push(object.headVersionId);

    const version = getLibraryVersion(db, object.headVersionId);
    if (!version || version.definitionKind !== "skill_spec") return;
    const payload = version.payload as { baseSkillRef?: string };
    if (typeof payload.baseSkillRef === "string" && payload.baseSkillRef.length > 0) {
      visit(payload.baseSkillRef);
    }
  };

  for (const skillRef of skillRefs) {
    visit(skillRef);
  }

  return refs;
}

function renderTaskPrompt(
  profile: ReturnType<typeof profileForNode>,
  issue: TodoWebFeatureIssuePacket,
): string {
  const roleSpecific = profile.roleRef === "maker"
    ? [
      "You must implement missing feature code in the current repository.",
      "Required changed files: src/todo-store.ts, src/app.ts, src/styles.css, README.md, and at least one file under test/.",
      "Overdue semantics are calendar-day based: a todo due today must NOT be overdue in any timezone; only due dates before today are overdue.",
      "Run npm test in /workspace/repo and include exact command output and test results.",
      "Browser contract required by acceptance harness: form/input controls must expose data-testid values todo-input, todo-priority, todo-due-date, add-todo; rendered priority labels must expose data-testid todo-priority-label.",
    ]
    : profile.roleRef === "checker"
    ? [
      "Verify that priority labels render, overdue filtering works, and localStorage persistence survives reload.",
      "Run targeted timezone checks to ensure due-today is not overdue (for example with TZ=America/New_York and TZ=America/Los_Angeles).",
      "Reject if required files were not changed, npm test did not run, overdue semantics are timezone-buggy, or required browser selectors (todo-input, todo-priority, todo-due-date, add-todo, todo-priority-label, filter-overdue) are missing.",
    ]
    : profile.roleRef === "summarizer"
    ? [
      "Summarize accepted implementation and verification evidence only after previous stages succeeded.",
    ]
    : [
      "Provide concise planning/analysis grounded in repository facts.",
    ];

  return [
    `Role: ${profile.roleRef}`,
    `Issue: ${issue.title}`,
    issue.body,
    `Acceptance: ${issue.acceptanceCriteria.join("; ")}`,
    `Artifact contract: ${profile.requiredArtifactRef}`,
    `Required top-level keys: ${requiredArtifactKeys(profile.requiredArtifactRef).join(", ")}`,
    "Return one JSON object with those exact top-level keys.",
    "Do not wrap the artifact inside another object key.",
    "Use only the mounted /workspace/repo and include concrete command/test evidence.",
    ...roleSpecific,
  ].join("\n");
}

function requiredArtifactKeys(
  artifactRef: ReturnType<typeof profileForNode>["requiredArtifactRef"],
): string[] {
  switch (artifactRef) {
    case "implementation_plan":
      return ["summary", "filesToInspect", "commandsToRun", "risks"];
    case "implementation_report":
      return ["summary", "filesChanged", "commandsRun", "testResults", "risks", "artifactEvidence"];
    case "verification_report":
      return ["summary", "commandsRun", "testResults", "checkerFindings", "risks"];
    case "completion_report":
      return ["summary", "acceptedArtifacts", "tests", "risks", "followUps"];
    default:
      return ["summary"];
  }
}
