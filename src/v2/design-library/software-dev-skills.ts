import type { SouthstarDb } from "../stores/sqlite.ts";
import {
  appendVersionCreated,
  createLibraryObject,
  findLibraryObjectByKey,
  listLibraryVersions,
} from "./store.ts";
import type {
  LibraryActorType,
  SkillSpecPayload,
} from "./types.ts";

type SkillSeed = {
  objectKey: string;
  payload: SkillSpecPayload;
};

const repairGuidance: SkillSpecPayload["repairGuidance"] = {
  template: [
    "## Repair Required (Attempt {attempt}/{maxAttempts})",
    "",
    "Missing fields: {missingFieldsList}",
    "",
    "For each missing field, refer to your skill sections:",
    "{fieldInstructions}",
    "",
    "Then:",
    "1. Collect data for ALL missing fields",
    "2. Generate complete JSON with ALL required fields",
    "3. Self-validate using your skill checklist",
    "4. Submit only after validation passes",
  ].join("\n"),
  fieldReferenceFormat: "- {field} -> {sectionId}: {description}",
};

const baseSkill: SkillSeed = {
  objectKey: "software-dev.skill.artifact-generator-base",
  payload: {
    schemaVersion: "southstar.library.skill_spec.v1",
    skillType: "base",
    title: "Artifact Generator Base",
    description: "Common output and validation rules for Southstar software artifact generation.",
    instructions: {
      format: "markdown",
      content: [
        "# Artifact Generator Base Skill",
        "",
        "## Critical Output Rules",
        "Return exactly one JSON object with top-level keys: artifact, progress, metrics.",
        "Response must start with { and end with }.",
        "Do not write explanatory text before or after JSON.",
        "Do not wrap required artifact fields under extra nested keys.",
        "Do not return only file paths; return artifact content directly.",
        "",
        "## Self-Validation Checklist",
        "Before submit, verify: valid JSON syntax, all required fields present, required fields at top level inside artifact, no placeholders, and required evidence fields populated.",
        "",
        "## Repair Attempts",
        "When repair is requested, use the field sections in your specialized skill and regenerate the complete artifact before resubmission.",
      ].join("\n"),
    },
    domainRefs: ["software"],
    designedFor: ["pi-agent"],
    allowedTools: ["read", "search", "shell", "edit", "write"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    contractRefs: [
      "software-dev.contract.implementation-artifact",
      "software-dev.contract.verification-artifact",
      "software-dev.contract.completion-artifact",
    ],
    provenance: {
      source: "seed",
      createdBy: "migration",
    },
  },
};

function arrayField(field: string): boolean {
  return [
    "filesToInspect",
    "commandsToRun",
    "filesChanged",
    "commandsRun",
    "testResults",
    "artifactEvidence",
    "checkerFindings",
    "risks",
    "acceptedArtifacts",
    "tests",
    "followUps",
  ].includes(field);
}

function genericFieldGuidance(fields: string[]): NonNullable<SkillSpecPayload["fieldGuidance"]> {
  return Object.fromEntries(fields.map((field) => [field, {
    sectionId: `#field-${field}`,
    description: `Generate ${field} according to artifact contract requirements`,
    dataType: arrayField(field) ? "array" : "string",
    generationSteps: [
      `Collect source facts for ${field}`,
      `Format ${field} with contract-compliant shape`,
    ],
    example: arrayField(field) ? [] : `${field} value`,
    validation: [`${field} must be present and contract-compliant`],
  }]));
}

function checkerFieldGuidance(): NonNullable<SkillSpecPayload["fieldGuidance"]> {
  return {
    summary: {
      sectionId: "#field-summary",
      description: "Brief summary of verification outcome",
      dataType: "string",
      generationSteps: [
        "Run verification commands and tests",
        "Summarize whether acceptance criteria are met",
        "Mention any blocking issues",
      ],
      example: "All tests pass and acceptance criteria are satisfied with no critical risks.",
      validation: ["Must be non-empty", "Should mention tests", "Should mention acceptance criteria"],
    },
    commandsRun: {
      sectionId: "#field-commandsRun",
      description: "Commands executed during verification",
      dataType: "array",
      generationSteps: [
        "Record each shell command executed",
        "Ensure test commands are included",
      ],
      example: ["cd /workspace/repo", "npm test"],
      validation: ["Must be array", "Should include npm test"],
    },
    testResults: {
      sectionId: "#field-testResults",
      description: "Structured test execution results",
      dataType: "array",
      generationSteps: [
        "Capture command name",
        "Capture pass/fail status",
        "Capture output and exit code",
      ],
      example: [{ command: "npm test", passed: true, output: "8 passing", exitCode: 0 }],
      validation: ["Must be array", "Each item needs command, passed, output, exitCode"],
    },
    checkerFindings: {
      sectionId: "#field-checkerFindings",
      description: "Verification findings mapped to acceptance criteria",
      dataType: "array",
      generationSteps: [
        "Enumerate acceptance criteria",
        "Write one finding per criterion",
      ],
      example: ["Priority labels render correctly"],
      validation: ["Must be array", "Should cover criteria"],
    },
    risks: {
      sectionId: "#field-risks",
      description: "Identified risks and concerns",
      dataType: "array",
      generationSteps: [
        "List remaining risks",
        "Return [] if no risks remain",
      ],
      example: [],
      validation: ["Must be array"],
    },
  };
}

function specializedMarkdown(title: string, roleInstructions: string, fields: string[]): string {
  return [
    `# ${title} Skill`,
    "",
    "## Process",
    roleInstructions,
    "",
    "## Field Generation Guide",
    ...fields.flatMap((field) => [
      `### ${field} {#field-${field}}`,
      `Generate ${field} according to contract evidence and task context.`,
      "",
    ]),
    "## Self-Validation",
    `Verify required fields are present: ${fields.join(", ")}.`,
    "Verify output is exactly one JSON object with artifact/progress/metrics.",
  ].join("\n");
}

function specializedSkill(input: {
  objectKey: string;
  title: string;
  description: string;
  roleRefs: string[];
  taskRefs: string[];
  contractRefs: string[];
  fields: string[];
  fieldGuidance?: NonNullable<SkillSpecPayload["fieldGuidance"]>;
}): SkillSeed {
  return {
    objectKey: input.objectKey,
    payload: {
      schemaVersion: "southstar.library.skill_spec.v1",
      skillType: "specialized",
      title: input.title,
      description: input.description,
      baseSkillRef: baseSkill.objectKey,
      instructions: {
        format: "markdown",
        content: specializedMarkdown(input.title, input.description, input.fields),
      },
      domainRefs: ["software"],
      roleRefs: input.roleRefs,
      taskRefs: input.taskRefs,
      contractRefs: input.contractRefs,
      designedFor: ["pi-agent"],
      allowedTools: ["read", "search", "shell"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      fieldGuidance: input.fieldGuidance ?? genericFieldGuidance(input.fields),
      repairGuidance,
      provenance: {
        source: "seed",
        createdBy: "migration",
      },
    },
  };
}

export const softwareDevSkillSeeds: SkillSeed[] = [
  baseSkill,
  specializedSkill({
    objectKey: "software-dev.skill.explorer-context",
    title: "Explorer Context",
    description: "Inspect repository and issue context and produce implementation planning artifacts.",
    roleRefs: ["explorer"],
    taskRefs: ["explorer"],
    contractRefs: ["software-dev.contract.issue-input"],
    fields: ["summary", "filesToInspect", "commandsToRun", "risks"],
  }),
  specializedSkill({
    objectKey: "software-dev.skill.planner-planning",
    title: "Planner Planning",
    description: "Convert issue and repository facts into an executable implementation plan.",
    roleRefs: ["explorer", "planner"],
    taskRefs: ["planner"],
    contractRefs: ["software-dev.contract.issue-input"],
    fields: ["summary", "filesToInspect", "commandsToRun", "risks"],
  }),
  specializedSkill({
    objectKey: "software-dev.skill.implementer-implementation",
    title: "Implementer Implementation",
    description: [
      "Implement requested changes with test and command evidence.",
      "For todo-web browser behavior compatibility, ensure UI controls use these test ids: todo-input, todo-priority, todo-due-date, add-todo, todo-priority-label, filter-overdue.",
      "`todo-priority` must be a selectable priority control and `todo-priority-label` must render each todo priority label.",
    ].join("\n"),
    roleRefs: ["maker", "implementer"],
    taskRefs: ["implementer"],
    contractRefs: ["software-dev.contract.implementation-artifact"],
    fields: ["summary", "filesChanged", "commandsRun", "testResults", "risks", "artifactEvidence"],
  }),
  specializedSkill({
    objectKey: "software-dev.skill.checker-verification",
    title: "Checker Verification",
    description: [
      "Verify acceptance criteria, tests, and evidence quality without editing implementation files.",
      "Confirm todo-web browser selectors exist and work: todo-input, todo-priority, todo-due-date, add-todo, todo-priority-label, filter-overdue.",
      "Reject artifacts when selector contracts are not met or browser behavior cannot satisfy overdue-filter and reload persistence checks.",
    ].join("\n"),
    roleRefs: ["checker"],
    taskRefs: ["checker"],
    contractRefs: ["software-dev.contract.verification-artifact"],
    fields: ["summary", "commandsRun", "testResults", "checkerFindings", "risks"],
    fieldGuidance: checkerFieldGuidance(),
  }),
  specializedSkill({
    objectKey: "software-dev.skill.summarizer-completion",
    title: "Summarizer Completion",
    description: "Summarize accepted artifacts and remaining follow-up risks.",
    roleRefs: ["summarizer"],
    taskRefs: ["summarizer"],
    contractRefs: ["software-dev.contract.completion-artifact"],
    fields: ["summary", "acceptedArtifacts", "tests", "risks", "followUps"],
  }),
];

export function seedSoftwareDevSkills(db: SouthstarDb, input: {
  actorType: Extract<LibraryActorType, "migration" | "system" | "user">;
}): { createdObjectIds: string[]; createdVersionIds: string[] } {
  const createdObjectIds: string[] = [];
  const createdVersionIds: string[] = [];

  for (const seed of softwareDevSkillSeeds) {
    const existing = findLibraryObjectByKey(db, seed.objectKey);
    const objectId = existing?.objectId ?? createLibraryObject(db, {
      objectKey: seed.objectKey,
      objectKind: "skill_spec",
      status: "approved",
      state: {
        tags: ["software", "skill"],
        domainRefs: ["software"],
      },
      actorType: input.actorType,
    }).objectId;
    if (!existing) createdObjectIds.push(objectId);

    const versions = listLibraryVersions(db, objectId);
    if (versions.length === 0) {
      const versionId = `ver-${seed.objectKey.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-2026-06-17`;
      appendVersionCreated(db, {
        objectId,
        definitionKind: "skill_spec",
        versionId,
        payload: seed.payload,
        createdBy: input.actorType,
        status: "approved",
      });
      createdVersionIds.push(versionId);
    }
  }

  return { createdObjectIds, createdVersionIds };
}
