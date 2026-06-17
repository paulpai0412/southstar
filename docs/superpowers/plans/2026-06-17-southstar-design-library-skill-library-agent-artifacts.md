# Southstar Design Library Skill Library Agent Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Design Library-backed skill library that injects structured artifact-generation instructions and repair guidance into real Pi-agent workflows so software-dev agents produce contract-valid artifacts.

**Architecture:** Reuse the existing `src/v2/skills/*` runtime path instead of creating a parallel mechanism. Design Library `skill_spec` objects resolve through a library-backed `SkillCatalog`, become `ResolvedSkillSnapshot`s, enter `TaskEnvelopeV2.skills`, and are injected by the Pi SDK harness. Repair instructions remain pure runtime logic, but use repair metadata carried in skill snapshots rather than hardcoded per-contract field guidance.

**Tech Stack:** TypeScript ESM, Node test runner, native SQLite through existing `SouthstarDb`, existing Design Library object/version store, existing Tork/Pi real E2E harness.

---

## Execution Goal Prompt

Use this prompt for the implementation worker:

```text
Implement the Southstar Design Library-backed Skill Library for software-dev agents.

Use the design spec at docs/superpowers/specs/2026-06-17-southstar-design-library-skill-library-agent-artifacts-design.zh.md as authoritative.

Build support for skill_spec library objects, a library-backed SkillCatalog, baseSkillRef expansion, skill snapshot repair metadata, task-specific skillRefs in the design-library compiler, structured repair instructions that reference skill section IDs, and real Pi-agent prompt injection through TaskEnvelopeV2.skills.

Create seeded software-dev skills:
- software-dev.skill.artifact-generator-base
- software-dev.skill.explorer-context
- software-dev.skill.planner-planning
- software-dev.skill.implementer-implementation
- software-dev.skill.checker-verification
- software-dev.skill.summarizer-completion

Acceptance must use the real todo-web Design Library E2E, local Tork at http://localhost:8000, and local SQLite SOUTHSTAR_DB. Do not use calc, fake, mock, smoke, codex, opencode, or builtin-agent paths for final E2E acceptance.
```

## Quantitative Acceptance Standards

Final implementation is accepted only when all of the following hold:

1. Unit suite passes: `npm test` exits 0.
2. Skill seed count: exactly 6 `skill_spec` objects seeded for software-dev.
3. Base expansion: each of the 5 specialized skills resolves with `software-dev.skill.artifact-generator-base` exactly once.
4. Compiler output: the todo-web Design Library manifest has 5 executable tasks and each task has at least 2 skill refs: base plus task-specific skill.
5. Runtime snapshots: for a compiled todo-web run, every task envelope has `skills.length >= 2` and all skill snapshots have non-empty `instructions` and `contentHash` length >= 32.
6. Checker repair metadata: `software-dev.skill.checker-verification` snapshot includes field guidance for exactly `summary`, `commandsRun`, `testResults`, `checkerFindings`, `risks`.
7. Repair instruction: missing checker fields produce a repair instruction containing at least 5 field-section references and no hardcoded checker field descriptions outside skill metadata.
8. Real E2E command passes:
   ```bash
   TORK_BASE_URL=http://localhost:8000 SOUTHSTAR_DB=/tmp/southstar-e2e-test.db npm run test:e2e:design-library-real
   ```
9. Real E2E guard: source and execution path do not use `calc`, `fake`, `mock`, `smoke`, `codex`, `opencode`, or `builtin-agent` for the final acceptance case.
10. Checker artifact in the real E2E has all 5 required fields and evidence validator reports `command-output` and `test-result` as present.

---

## File Structure

Create:
- `src/v2/skills/library-backed-catalog.ts` — resolves `skill_spec` objects from Design Library into `SkillSourceDefinition`s and expands base dependencies.
- `src/v2/design-library/software-dev-skills.ts` — contains seed payloads and markdown instructions for the 6 software-dev skills.
- `tests/v2/skill-library.test.ts` — unit tests for `skill_spec` seed, catalog resolution, base expansion, and cycle detection.
- `tests/v2/skill-repair-guidance.test.ts` — unit tests for formatted repair instruction generation from skill metadata.

Modify:
- `src/v2/design-library/types.ts` — add `skill_spec` to `LibraryDefinitionKind` and define exported skill payload types.
- `src/v2/skills/types.ts` — extend `SkillSourceDefinition` with `fieldGuidance`, `repairGuidance`, and `baseSkillRefs`.
- `src/v2/skills/resolver.ts` — support catalog-provided base-expanded skills and persist repair metadata in snapshots.
- `src/v2/design-library/software-dev-seed.ts` — seed the 6 skill specs idempotently and attach skill refs to agent/capability/template metadata where appropriate.
- `src/v2/design-library/compiler.ts` — emit task-specific `skillRefs` and include skill library version refs in `compiledFrom.libraryVersionRefs`.
- `src/v2/agent-runner/root-session.ts` — build structured repair instructions from skill snapshot metadata while keeping artifact gate pure.
- `src/v2/agent-runner/task-runner.ts` — pass repair context from envelope skills into artifact gate evaluation.
- `src/v2/harness/pi-sdk-harness.ts` — improve skill instruction prompt delimiters and ensure repair instruction appears after skill instructions.
- `tests/v2/index.test.ts` — import new unit test files.
- `tests/v2/design-library-compiler.test.ts` — assert task-specific skill refs and version refs.
- `tests/v2/root-session.test.ts` — assert repair instruction behavior if the new standalone repair test is not sufficient.
- `tests/e2e-real/design-library-template-real.test.ts` — strengthen non-calc/non-fake guards and assert skill/evidence outcomes.

---

### Task 1: Add Skill Spec Types

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/skills/types.ts`
- Test: `tests/v2/skill-library.test.ts`

- [ ] **Step 1: Write failing type/seed shape test**

Create `tests/v2/skill-library.test.ts` with this initial content:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { LibraryDefinitionKind } from "../../src/v2/design-library/types.ts";
import type { SkillSourceDefinition } from "../../src/v2/skills/types.ts";

test("skill_spec is a supported library definition kind", () => {
  const kind: LibraryDefinitionKind = "skill_spec";
  assert.equal(kind, "skill_spec");
});

test("skill source definitions can carry repair guidance metadata", () => {
  const skill: SkillSourceDefinition = {
    skillId: "software-dev.skill.checker-verification",
    version: "2026-06-17",
    instructions: "# Checker Verification",
    allowedTools: ["read", "search", "shell"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["verification_report"],
    baseSkillRefs: ["software-dev.skill.artifact-generator-base"],
    fieldGuidance: {
      summary: {
        sectionId: "#field-summary",
        description: "Brief summary of verification outcome",
        dataType: "string",
        generationSteps: ["Run tests", "Check acceptance criteria", "Write two sentences"],
        example: "All tests pass and all criteria are met.",
        validation: ["Must be non-empty"],
      },
    },
    repairGuidance: {
      template: "Missing fields: {missingFieldsList}\n{fieldInstructions}",
      fieldReferenceFormat: "- {field} -> {sectionId}: {description}",
    },
  };

  assert.equal(skill.baseSkillRefs?.[0], "software-dev.skill.artifact-generator-base");
  assert.equal(skill.fieldGuidance?.summary.sectionId, "#field-summary");
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-library.test.ts
```

Expected: TypeScript compile/type stripping or runtime import fails because `"skill_spec"` is not part of `LibraryDefinitionKind` or skill metadata fields do not exist.

- [ ] **Step 3: Add types**

Modify `src/v2/design-library/types.ts`:

```ts
export type LibraryDefinitionKind =
  | "agent_spec"
  | "capability_spec"
  | "contract_spec"
  | "validator_spec"
  | "policy_bundle"
  | "workflow_template"
  | "workflow_recipe"
  | "skill_spec";

export type SkillFieldGuidance = {
  sectionId: string;
  description: string;
  dataType: "string" | "array" | "object" | "boolean" | "number";
  generationSteps: string[];
  example: unknown;
  validation: string[];
};

export type SkillRepairGuidance = {
  template: string;
  fieldReferenceFormat: string;
};

export type SkillSpecPayload = {
  schemaVersion: "southstar.library.skill_spec.v1";
  skillType: "base" | "specialized";
  title: string;
  description: string;
  baseSkillRef?: string;
  instructions: { format: "markdown"; content: string };
  domainRefs: string[];
  roleRefs?: string[];
  taskRefs?: string[];
  contractRefs?: string[];
  designedFor: Array<"pi-agent" | "codex" | "opencode">;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  fieldGuidance?: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
  provenance: DefinitionProvenance;
};
```

Modify `src/v2/skills/types.ts`:

```ts
import type { SkillFieldGuidance, SkillRepairGuidance } from "../design-library/types.ts";

export type SkillSourceDefinition = {
  skillId: string;
  version: string;
  instructions: string;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  artifactContracts: string[];
  baseSkillRefs?: string[];
  fieldGuidance?: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
};
```

Keep existing `ResolvedSkillSnapshot` and `SkillCatalog` definitions unchanged except for the widened base type.

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-library.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/design-library/types.ts src/v2/skills/types.ts tests/v2/skill-library.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: add skill spec metadata types"
```

---

### Task 2: Seed Six Software-Dev Skill Specs

**Files:**
- Create: `src/v2/design-library/software-dev-skills.ts`
- Modify: `src/v2/design-library/software-dev-seed.ts`
- Modify: `tests/v2/skill-library.test.ts`

- [ ] **Step 1: Add failing seed tests**

Append to `tests/v2/skill-library.test.ts`:

```ts
import { createSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { findLibraryObjectByKey, listLibraryVersions } from "../../src/v2/design-library/store.ts";
import { seedSoftwareDevSkills } from "../../src/v2/design-library/software-dev-skills.ts";

const expectedSkillKeys = [
  "software-dev.skill.artifact-generator-base",
  "software-dev.skill.explorer-context",
  "software-dev.skill.planner-planning",
  "software-dev.skill.implementer-implementation",
  "software-dev.skill.checker-verification",
  "software-dev.skill.summarizer-completion",
];

test("software-dev skill seed creates six approved skill specs", () => {
  const db = createSouthstarDb(":memory:");
  seedSoftwareDevSkills(db, { actorType: "migration" });

  for (const key of expectedSkillKeys) {
    const object = findLibraryObjectByKey(db, key);
    assert.ok(object, `missing ${key}`);
    assert.equal(object.objectKind, "skill_spec");
    assert.equal(object.status, "approved");
    const versions = listLibraryVersions(db, object.objectId);
    assert.equal(versions.length, 1);
  }
});

test("checker verification skill defines guidance for all verification report fields", () => {
  const db = createSouthstarDb(":memory:");
  seedSoftwareDevSkills(db, { actorType: "migration" });
  const object = findLibraryObjectByKey(db, "software-dev.skill.checker-verification");
  assert.ok(object);
  const [version] = listLibraryVersions(db, object.objectId);
  const payload = version.payload as { baseSkillRef?: string; fieldGuidance?: Record<string, unknown> };
  assert.equal(payload.baseSkillRef, "software-dev.skill.artifact-generator-base");
  assert.deepEqual(Object.keys(payload.fieldGuidance ?? {}).sort(), [
    "checkerFindings",
    "commandsRun",
    "risks",
    "summary",
    "testResults",
  ]);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-library.test.ts
```

Expected: FAIL because `software-dev-skills.ts` does not exist.

- [ ] **Step 3: Create seed module**

Create `src/v2/design-library/software-dev-skills.ts` with:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { createLibraryObject, appendVersionCreated, findLibraryObjectByKey, listLibraryVersions } from "./store.ts";
import type { LibraryActorType, SkillSpecPayload } from "./types.ts";

export const softwareDevSkillSpecs: Array<{ objectKey: string; payload: SkillSpecPayload }> = [
  {
    objectKey: "software-dev.skill.artifact-generator-base",
    payload: {
      schemaVersion: "southstar.library.skill_spec.v1",
      skillType: "base",
      title: "Artifact Generator Base",
      description: "Common rules for returning contract-valid Southstar artifacts.",
      instructions: {
        format: "markdown",
        content: [
          "# Artifact Generator Base Skill",
          "",
          "## Critical Output Rules",
          "Return exactly one JSON object with top-level keys: artifact, progress, metrics.",
          "The response must start with { and end with }.",
          "Do not write explanatory text before or after the JSON.",
          "Do not use markdown code fences.",
          "Do not return a file path instead of artifact content.",
          "",
          "## Self-Validation Checklist",
          "Before submitting, verify valid JSON syntax, top-level artifact/progress/metrics keys, all contract required fields inside artifact, no placeholder strings, and evidence fields populated where applicable.",
          "",
          "## Repair Attempts",
          "When given a repair instruction, use the referenced field sections in the specialized skill, regenerate the complete artifact, and self-validate again before submitting.",
        ].join("\n"),
      },
      domainRefs: ["software"],
      designedFor: ["pi-agent"],
      allowedTools: ["read", "search", "shell", "edit"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      contractRefs: [],
      provenance: { source: "seed", createdBy: "migration" },
    },
  },
  makeSpecializedSkill({
    objectKey: "software-dev.skill.explorer-context",
    title: "Explorer Context",
    roleRefs: ["explorer"],
    taskRefs: ["explorer"],
    contractRefs: ["implementation_plan"],
    instructions: "Read repository facts, list files to inspect, propose commands to run, and return implementation_plan fields.",
    fieldNames: ["summary", "filesToInspect", "commandsToRun", "risks"],
  }),
  makeSpecializedSkill({
    objectKey: "software-dev.skill.planner-planning",
    title: "Planner Planning",
    roleRefs: ["explorer"],
    taskRefs: ["planner"],
    contractRefs: ["implementation_plan"],
    instructions: "Convert issue requirements and repository facts into a concise implementation plan artifact.",
    fieldNames: ["summary", "filesToInspect", "commandsToRun", "risks"],
  }),
  makeSpecializedSkill({
    objectKey: "software-dev.skill.implementer-implementation",
    title: "Implementer Implementation",
    roleRefs: ["maker"],
    taskRefs: ["implementer"],
    contractRefs: ["implementation_report"],
    instructions: "Implement the requested change, run tests, collect evidence, and return implementation_report fields.",
    fieldNames: ["summary", "filesChanged", "commandsRun", "testResults", "risks", "artifactEvidence"],
  }),
  makeSpecializedSkill({
    objectKey: "software-dev.skill.checker-verification",
    title: "Checker Verification",
    roleRefs: ["checker"],
    taskRefs: ["checker"],
    contractRefs: ["verification_report"],
    instructions: "Verify tests, acceptance criteria, command output, and risks without editing files.",
    fieldNames: ["summary", "commandsRun", "testResults", "checkerFindings", "risks"],
    fieldGuidance: checkerFieldGuidance(),
  }),
  makeSpecializedSkill({
    objectKey: "software-dev.skill.summarizer-completion",
    title: "Summarizer Completion",
    roleRefs: ["summarizer"],
    taskRefs: ["summarizer"],
    contractRefs: ["completion_report"],
    instructions: "Summarize accepted implementation and verification artifacts into a completion report.",
    fieldNames: ["summary", "acceptedArtifacts", "tests", "risks", "followUps"],
  }),
];

export function seedSoftwareDevSkills(db: SouthstarDb, input: { actorType: Extract<LibraryActorType, "migration" | "system" | "user"> }): { createdObjectIds: string[]; createdVersionIds: string[] } {
  const createdObjectIds: string[] = [];
  const createdVersionIds: string[] = [];
  for (const seed of softwareDevSkillSpecs) {
    const existing = findLibraryObjectByKey(db, seed.objectKey);
    const objectId = existing?.objectId ?? createLibraryObject(db, {
      objectKey: seed.objectKey,
      objectKind: "skill_spec",
      status: "approved",
      state: { tags: ["software", "skill"], domainRefs: ["software"] },
      actorType: input.actorType,
    }).objectId;
    if (!existing) createdObjectIds.push(objectId);
    const versions = listLibraryVersions(db, objectId);
    if (versions.length === 0) {
      const versionId = `ver-${seed.objectKey.replace(/[^a-z0-9]+/gi, "-")}-2026-06-17`;
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

function makeSpecializedSkill(input: {
  objectKey: string;
  title: string;
  roleRefs: string[];
  taskRefs: string[];
  contractRefs: string[];
  instructions: string;
  fieldNames: string[];
  fieldGuidance?: SkillSpecPayload["fieldGuidance"];
}): { objectKey: string; payload: SkillSpecPayload } {
  return {
    objectKey: input.objectKey,
    payload: {
      schemaVersion: "southstar.library.skill_spec.v1",
      skillType: "specialized",
      title: input.title,
      description: input.instructions,
      baseSkillRef: "software-dev.skill.artifact-generator-base",
      instructions: {
        format: "markdown",
        content: specializedMarkdown(input.title, input.instructions, input.fieldNames),
      },
      domainRefs: ["software"],
      roleRefs: input.roleRefs,
      taskRefs: input.taskRefs,
      contractRefs: input.contractRefs,
      designedFor: ["pi-agent"],
      allowedTools: ["read", "search", "shell", "edit"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      fieldGuidance: input.fieldGuidance ?? genericFieldGuidance(input.fieldNames),
      repairGuidance: {
        template: "## Repair Required (Attempt {attempt}/{maxAttempts})\n\nMissing fields: {missingFieldsList}\n\nFor each missing field, refer to your skill sections:\n{fieldInstructions}\n\nThen collect all missing data, generate complete JSON, self-validate, and submit only after validation passes.",
        fieldReferenceFormat: "- {field} -> {sectionId}: {description}",
      },
      provenance: { source: "seed", createdBy: "migration" },
    },
  };
}

function specializedMarkdown(title: string, instructions: string, fieldNames: string[]): string {
  return [
    `# ${title} Skill`,
    "",
    "## Role Process",
    instructions,
    "",
    "## Field Generation Guide",
    ...fieldNames.map((field) => [`### ${field} {#field-${field}}`, `Generate the ${field} field according to the artifact contract.`, ""].join("\n")),
    "## Self-Validation",
    `Verify artifact contains: ${fieldNames.join(", ")}.`,
  ].join("\n");
}

function genericFieldGuidance(fieldNames: string[]): NonNullable<SkillSpecPayload["fieldGuidance"]> {
  return Object.fromEntries(fieldNames.map((field) => [field, {
    sectionId: `#field-${field}`,
    description: `Generate ${field} for the artifact contract`,
    dataType: field.endsWith("s") || ["commandsRun", "commandsToRun", "filesChanged", "filesToInspect", "testResults", "acceptedArtifacts", "tests", "risks", "followUps", "artifactEvidence"].includes(field) ? "array" : "string",
    generationSteps: [`Collect source data for ${field}`, `Format ${field} according to the contract`],
    example: field.endsWith("s") ? [] : `${field} value`,
    validation: [`${field} must be present`],
  }]));
}

function checkerFieldGuidance(): NonNullable<SkillSpecPayload["fieldGuidance"]> {
  return {
    summary: { sectionId: "#field-summary", description: "Brief summary of verification outcome", dataType: "string", generationSteps: ["Run tests", "Check acceptance criteria", "Write two to three sentences"], example: "All tests pass and all acceptance criteria are met.", validation: ["Must be non-empty", "Mentions tests", "Mentions acceptance criteria"] },
    commandsRun: { sectionId: "#field-commandsRun", description: "Record of commands executed", dataType: "array", generationSteps: ["Record each shell command", "Include npm test"], example: ["cd /workspace/repo", "npm test"], validation: ["Must be array", "Includes npm test"] },
    testResults: { sectionId: "#field-testResults", description: "Structured test execution data", dataType: "array", generationSteps: ["Capture command", "Capture exitCode", "Capture output"], example: [{ command: "npm test", passed: true, output: "8 passing", exitCode: 0 }], validation: ["Must be array", "Each item has command, passed, output, exitCode"] },
    checkerFindings: { sectionId: "#field-checkerFindings", description: "Verification outcome for acceptance criteria", dataType: "array", generationSteps: ["List each acceptance criterion", "Write a finding for each criterion"], example: ["Priority labels render correctly"], validation: ["Must be array", "Covers acceptance criteria"] },
    risks: { sectionId: "#field-risks", description: "Identified risks or concerns", dataType: "array", generationSteps: ["Review edge cases", "Return empty array when no risks are found"], example: [], validation: ["Must be array", "Can be empty"] },
  };
}
```

- [ ] **Step 4: Wire seed into existing software-dev seed**

Modify `src/v2/design-library/software-dev-seed.ts`:

```ts
import { seedSoftwareDevSkills } from "./software-dev-skills.ts";
```

At the end of `seedSoftwareDevDesignLibrary`, before return:

```ts
  const seededSkills = seedSoftwareDevSkills(db, { actorType: input.actorType });
  createdObjectIds.push(...seededSkills.createdObjectIds);
  createdVersionIds.push(...seededSkills.createdVersionIds);
```

- [ ] **Step 5: Run test and verify it passes**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-library.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/design-library/software-dev-skills.ts src/v2/design-library/software-dev-seed.ts tests/v2/skill-library.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: seed software dev skill specs"
```

---

### Task 3: Add Library-Backed Skill Catalog and Base Expansion

**Files:**
- Create: `src/v2/skills/library-backed-catalog.ts`
- Modify: `src/v2/skills/resolver.ts`
- Modify: `tests/v2/skill-library.test.ts`

- [ ] **Step 1: Add failing catalog tests**

Append to `tests/v2/skill-library.test.ts`:

```ts
import { createLibraryBackedSkillCatalog } from "../../src/v2/skills/library-backed-catalog.ts";
import { resolveSkillSnapshots } from "../../src/v2/skills/resolver.ts";

test("library-backed skill catalog resolves checker skill with base metadata", () => {
  const db = createSouthstarDb(":memory:");
  seedSoftwareDevSkills(db, { actorType: "migration" });
  const catalog = createLibraryBackedSkillCatalog(db);
  const skill = catalog.resolve("software-dev.skill.checker-verification");
  assert.equal(skill.skillId, "software-dev.skill.checker-verification");
  assert.equal(skill.baseSkillRefs?.[0], "software-dev.skill.artifact-generator-base");
  assert.equal(skill.fieldGuidance?.testResults.sectionId, "#field-testResults");
});

test("resolveSkillSnapshots expands base skill once before specialized skill", () => {
  const db = createSouthstarDb(":memory:");
  seedSoftwareDevSkills(db, { actorType: "migration" });
  const snapshots = resolveSkillSnapshots(db, {
    runId: "run-skill-test",
    taskId: "checker",
    skillRefs: ["software-dev.skill.checker-verification"],
    catalog: createLibraryBackedSkillCatalog(db),
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.skillId), [
    "software-dev.skill.artifact-generator-base",
    "software-dev.skill.checker-verification",
  ]);
  assert.equal(snapshots[1]?.fieldGuidance?.summary.sectionId, "#field-summary");
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-library.test.ts
```

Expected: FAIL because `library-backed-catalog.ts` does not exist and resolver does not expand base skills.

- [ ] **Step 3: Implement catalog**

Create `src/v2/skills/library-backed-catalog.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { findLibraryObjectByKey, getLibraryVersion } from "../design-library/store.ts";
import type { SkillSpecPayload } from "../design-library/types.ts";
import type { SkillCatalog, SkillSourceDefinition } from "./types.ts";

export function createLibraryBackedSkillCatalog(db: SouthstarDb): SkillCatalog {
  return {
    resolve(skillId: string): SkillSourceDefinition {
      const object = findLibraryObjectByKey(db, skillId);
      if (!object) throw new Error(`unknown skill: ${skillId}`);
      if (object.objectKind !== "skill_spec") throw new Error(`library object ${skillId} is not skill_spec`);
      if (!object.headVersionId) throw new Error(`skill ${skillId} has no head version`);
      const version = getLibraryVersion(db, object.headVersionId);
      if (!version) throw new Error(`skill ${skillId} head version not found: ${object.headVersionId}`);
      if (version.definitionKind !== "skill_spec") throw new Error(`skill ${skillId} version must be skill_spec`);
      const payload = version.payload as SkillSpecPayload;
      return {
        skillId,
        version: version.versionId,
        instructions: payload.instructions.content,
        allowedTools: payload.allowedTools,
        requiredMounts: payload.requiredMounts,
        mcpRequirements: payload.mcpRequirements,
        artifactContracts: payload.contractRefs ?? [],
        baseSkillRefs: payload.baseSkillRef ? [payload.baseSkillRef] : [],
        fieldGuidance: payload.fieldGuidance,
        repairGuidance: payload.repairGuidance,
      };
    },
  };
}
```

- [ ] **Step 4: Modify resolver to expand base refs**

Modify `src/v2/skills/resolver.ts` so `resolveSkillSnapshots` uses a recursive helper:

```ts
export function resolveSkillSnapshots(db: SouthstarDb, input: ResolveSkillSnapshotsInput): ResolvedSkillSnapshot[] {
  const catalog = input.catalog ?? builtInSkillCatalog;
  const resolved = expandSkills(input.skillRefs, catalog);
  return resolved.map((skill) => {
    const snapshot = toSnapshot(skill);
    upsertRuntimeResource(db, {
      resourceType: "skill_snapshot",
      resourceKey: `${input.runId}:${input.taskId}:${skill.skillId}`,
      runId: input.runId,
      taskId: input.taskId,
      scope: "task",
      status: "resolved",
      title: skill.skillId,
      payload: snapshot,
      summary: { version: snapshot.version, contentHash: snapshot.contentHash },
    });
    return snapshot;
  });
}

function expandSkills(skillRefs: string[], catalog: SkillCatalog): SkillSourceDefinition[] {
  const output: SkillSourceDefinition[] = [];
  const emitted = new Set<string>();
  const visiting: string[] = [];

  const visit = (skillRef: string) => {
    if (emitted.has(skillRef)) return;
    if (visiting.includes(skillRef)) {
      throw new Error(`skill base dependency cycle: ${[...visiting, skillRef].join(" -> ")}`);
    }
    visiting.push(skillRef);
    const skill = catalog.resolve(skillRef);
    for (const baseRef of skill.baseSkillRefs ?? []) visit(baseRef);
    visiting.pop();
    if (!emitted.has(skill.skillId)) {
      output.push(skill);
      emitted.add(skill.skillId);
    }
  };

  for (const skillRef of skillRefs) visit(skillRef);
  return output;
}
```

- [ ] **Step 5: Run test and verify it passes**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-library.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/skills/library-backed-catalog.ts src/v2/skills/resolver.ts tests/v2/skill-library.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: resolve design library skills"
```

---

### Task 4: Compile Task-Specific Skill Refs

**Files:**
- Modify: `src/v2/design-library/compiler.ts`
- Modify: `tests/v2/design-library-compiler.test.ts`

- [ ] **Step 1: Add failing compiler assertions**

In `tests/v2/design-library-compiler.test.ts`, add a test after existing compile tests:

```ts
test("design library compiler assigns task-specific software-dev skill refs", () => {
  const db = createSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const issue = todoWebFeatureIssuePacket("/tmp/todo-web-skill-test");
  const design = createWorkflowDesignDraftFromIssue(db, {
    issue,
    actorType: "llm",
    plannerClient: fixedPlannerClient(),
  });
  const approved = approveDraftForRun(db, { draftId: design.draftId, approvedBy: "user", version: "1.0.0" });
  const manifest = compileTemplateVersionToManifest(db, {
    templateVersionId: approved.templateVersionId,
    issue,
    runInputs: { repoPath: issue.repoPath, issueTitle: issue.title, issueBody: issue.body, acceptanceCriteria: issue.acceptanceCriteria },
    compilerVersion: "skill-library-test",
  });

  const skillRefsByTask = Object.fromEntries(manifest.tasks.map((task) => [task.id, task.skillRefs ?? []]));
  assert.ok(skillRefsByTask.explorer?.includes("software-dev.skill.explorer-context"));
  assert.ok(skillRefsByTask.planner?.includes("software-dev.skill.planner-planning"));
  assert.ok(skillRefsByTask.implementer?.includes("software-dev.skill.implementer-implementation"));
  assert.ok(skillRefsByTask.checker?.includes("software-dev.skill.checker-verification"));
  assert.ok(skillRefsByTask.summarizer?.includes("software-dev.skill.summarizer-completion"));
  assert.equal(manifest.compiledFrom.libraryVersionRefs.some((ref) => ref.includes("software-dev-skill")), true);
});
```

If existing test helpers use different names, adapt imports from the same file instead of creating duplicate helper functions.

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-compiler.test.ts
```

Expected: FAIL because `task.skillRefs` are empty.

- [ ] **Step 3: Implement skill selection**

Modify `src/v2/design-library/compiler.ts` with a helper:

```ts
function skillRefsForNode(node: WorkflowTemplatePayload["flow"]["nodes"][number]): string[] {
  const id = `${node.id} ${node.name} ${node.roleRef ?? ""}`.toLowerCase();
  if (id.includes("summar")) return ["software-dev.skill.summarizer-completion"];
  if (id.includes("check") || id.includes("verify") || id.includes("browser")) return ["software-dev.skill.checker-verification"];
  if (id.includes("planner") || id === "planner") return ["software-dev.skill.planner-planning"];
  if (id.includes("explorer") || id.includes("explore")) return ["software-dev.skill.explorer-context"];
  return ["software-dev.skill.implementer-implementation"];
}
```

Set task skill refs:

```ts
      skillRefs: skillRefsForNode(node),
```

Add skill version refs to `libraryVersionRefs` by looking up skill objects and their head versions:

```ts
  const skillVersionRefs = taskNodes
    .flatMap((node) => skillRefsForNode(node))
    .map((skillRef) => findLibraryObjectByKey(db, skillRef)?.headVersionId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const libraryVersionRefs = [
    input.templateVersionId,
    ...taskNodes.map((node) => node.agentSpecRef).filter((value): value is string => typeof value === "string" && value.length > 0),
    ...skillVersionRefs,
  ];
```

Import `findLibraryObjectByKey` from `./store.ts`.

- [ ] **Step 4: Run compiler test**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-compiler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/design-library/compiler.ts tests/v2/design-library-compiler.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: compile task skill refs"
```

---

### Task 5: Use Library-Backed Catalog During Envelope Materialization

**Files:**
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `tests/v2/task-envelope-v2.test.ts`

- [ ] **Step 1: Add failing envelope test**

Add to `tests/v2/task-envelope-v2.test.ts`:

```ts
test("TaskEnvelopeV2 includes resolved design library skill snapshots", () => {
  const db = createSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const runId = "run-envelope-skills";
  const task = makeWorkflowTask({ id: "checker", skillRefs: ["software-dev.skill.checker-verification"] });
  const skills = resolveTaskSkillsForTest(db, runId, task);
  assert.deepEqual(skills.map((skill) => skill.skillId), [
    "software-dev.skill.artifact-generator-base",
    "software-dev.skill.checker-verification",
  ]);
  assert.equal(skills[1]?.fieldGuidance?.testResults.sectionId, "#field-testResults");
});
```

If `resolveTaskSkills` is private, either export a focused helper from `local-api.ts` or add this assertion in an existing local API/materialization test that creates a real envelope.

- [ ] **Step 2: Run relevant test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/task-envelope-v2.test.ts
```

Expected: FAIL because resolver still uses only `builtInSkillCatalog`.

- [ ] **Step 3: Wire library-backed catalog**

Modify `src/v2/ui-api/local-api.ts` in `resolveTaskSkills`:

```ts
import { createLibraryBackedSkillCatalog } from "../skills/library-backed-catalog.ts";
```

Then call:

```ts
    const [snapshot] = resolveSkillSnapshots(db, {
      runId,
      taskId: task.id,
      skillRefs: [skillRef],
      catalog: createLibraryBackedSkillCatalog(db),
    });
```

Because base expansion can return more than one snapshot, replace one-at-a-time logic with all-at-once logic:

```ts
function resolveTaskSkills(db: SouthstarDb, runId: string, task: SouthstarWorkflowManifest["tasks"][number]): ResolvedSkillSnapshot[] {
  const skillRefs = task.skillRefs ?? [];
  if (skillRefs.length === 0) return [];
  const snapshots = resolveSkillSnapshots(db, {
    runId,
    taskId: task.id,
    skillRefs,
    catalog: createLibraryBackedSkillCatalog(db),
  });
  return snapshots;
}
```

Keep existing snapshot cache only if it can return the full expanded ordered list. If cache handling becomes ambiguous, prefer recomputing snapshots because `upsertRuntimeResource` is idempotent by resource key.

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/task-envelope-v2.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/ui-api/local-api.ts tests/v2/task-envelope-v2.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: materialize library skills in envelopes"
```

---

### Task 6: Structured Repair Instruction from Skill Metadata

**Files:**
- Modify: `src/v2/agent-runner/root-session.ts`
- Modify: `src/v2/agent-runner/task-runner.ts`
- Create: `tests/v2/skill-repair-guidance.test.ts`

- [ ] **Step 1: Write failing repair guidance test**

Create `tests/v2/skill-repair-guidance.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateArtifactGate } from "../../src/v2/agent-runner/root-session.ts";

test("artifact repair instruction references skill field sections", () => {
  const gate = evaluateArtifactGate({
    artifact: { summary: "partial" },
    requiredFields: ["summary", "commandsRun", "testResults", "checkerFindings", "risks"],
    attempt: 1,
    maxRepairAttempts: 2,
    repairContext: {
      contractId: "verification_report",
      fieldGuidance: {
        commandsRun: { sectionId: "#field-commandsRun", description: "Record of commands executed", dataType: "array", generationSteps: ["Record commands"], example: ["npm test"], validation: ["Must be array"] },
        testResults: { sectionId: "#field-testResults", description: "Structured test execution data", dataType: "array", generationSteps: ["Capture output"], example: [{ command: "npm test", passed: true, output: "ok", exitCode: 0 }], validation: ["Must be array"] },
        checkerFindings: { sectionId: "#field-checkerFindings", description: "Verification outcome for acceptance criteria", dataType: "array", generationSteps: ["Check criteria"], example: ["Criteria met"], validation: ["Must be array"] },
        risks: { sectionId: "#field-risks", description: "Identified risks or concerns", dataType: "array", generationSteps: ["Review risks"], example: [], validation: ["Must be array"] },
      },
      repairGuidance: {
        template: "Missing fields: {missingFieldsList}\n{fieldInstructions}",
        fieldReferenceFormat: "- {field} -> {sectionId}: {description}",
      },
    },
  });

  assert.equal(gate.decision, "repair");
  assert.match(gate.repairInstruction ?? "", /commandsRun -> #field-commandsRun/);
  assert.match(gate.repairInstruction ?? "", /testResults -> #field-testResults/);
  assert.match(gate.repairInstruction ?? "", /checkerFindings -> #field-checkerFindings/);
  assert.match(gate.repairInstruction ?? "", /risks -> #field-risks/);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-repair-guidance.test.ts
```

Expected: FAIL because `evaluateArtifactGate` has no `repairContext` input.

- [ ] **Step 3: Extend gate input and repair builder**

Modify `src/v2/agent-runner/root-session.ts`:

```ts
import type { SkillFieldGuidance, SkillRepairGuidance } from "../design-library/types.ts";

export type ArtifactRepairContext = {
  contractId: string;
  fieldGuidance: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
};

export type ArtifactGateInput = {
  artifact: Record<string, unknown>;
  requiredFields: string[];
  attempt: number;
  maxRepairAttempts: number;
  repairContext?: ArtifactRepairContext;
};
```

Replace repair instruction construction with:

```ts
    repairInstruction: buildRepairInstruction({
      missingFields,
      attempt: input.attempt + 1,
      maxAttempts: input.maxRepairAttempts,
      repairContext: input.repairContext,
    }),
```

Add helper:

```ts
function buildRepairInstruction(input: {
  missingFields: string[];
  attempt: number;
  maxAttempts: number;
  repairContext?: ArtifactRepairContext;
}): string {
  const fallback = `Artifact is missing required fields: ${input.missingFields.join(", ")}. Re-read your skill instructions, regenerate the complete artifact, and self-validate before submitting.`;
  const repairGuidance = input.repairContext?.repairGuidance;
  if (!repairGuidance) return fallback;
  const fieldInstructions = input.missingFields.map((field) => {
    const guidance = input.repairContext?.fieldGuidance[field];
    if (!guidance) return `- ${field} -> check the artifact contract and skill instructions`;
    return repairGuidance.fieldReferenceFormat
      .replaceAll("{field}", field)
      .replaceAll("{sectionId}", guidance.sectionId)
      .replaceAll("{description}", guidance.description);
  }).join("\n");
  return repairGuidance.template
    .replaceAll("{attempt}", String(input.attempt))
    .replaceAll("{maxAttempts}", String(input.maxAttempts))
    .replaceAll("{missingFieldsList}", input.missingFields.join(", "))
    .replaceAll("{fieldInstructions}", fieldInstructions);
}
```

- [ ] **Step 4: Pass repair context from task-runner**

Modify `src/v2/agent-runner/task-runner.ts` to derive repair context from `envelope.skills` and `envelope.artifactContracts`:

```ts
function repairContextFromEnvelope(envelope: AnyTaskEnvelope): ArtifactRepairContext | undefined {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return undefined;
  const contract = envelope.artifactContracts[0];
  const specialized = [...envelope.skills].reverse().find((skill) => Object.keys(skill.fieldGuidance ?? {}).length > 0);
  if (!contract || !specialized?.fieldGuidance) return undefined;
  return {
    contractId: contract.id,
    fieldGuidance: specialized.fieldGuidance,
    repairGuidance: specialized.repairGuidance,
  };
}
```

Pass it into `evaluateArtifactGate`:

```ts
    const gate = evaluateArtifactGate({
      artifact: harnessResult.artifact,
      requiredFields: input.requiredFields,
      attempt,
      maxRepairAttempts,
      repairContext: repairContextFromEnvelope(envelope),
    });
```

- [ ] **Step 5: Run repair test**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/skill-repair-guidance.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/agent-runner/root-session.ts src/v2/agent-runner/task-runner.ts tests/v2/skill-repair-guidance.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: format repair guidance from skills"
```

---

### Task 7: Improve Pi Harness Skill Prompt Delimiters

**Files:**
- Modify: `src/v2/harness/pi-sdk-harness.ts`
- Modify: `tests/v2/pi-sdk-harness.test.ts`

- [ ] **Step 1: Add failing prompt formatting test**

In `tests/v2/pi-sdk-harness.test.ts`, add or update a test that invokes the harness with a fake session and envelope containing two skills. Assert the prompt contains:

```ts
assert.match(promptText, /=== SKILL INSTRUCTIONS ===/);
assert.match(promptText, /software-dev.skill.artifact-generator-base/);
assert.match(promptText, /software-dev.skill.checker-verification/);
assert.match(promptText, /=== END SKILL INSTRUCTIONS ===/);
assert.equal(promptText.indexOf("=== END SKILL INSTRUCTIONS ===") < promptText.indexOf("Attempt: 1"), true);
```

- [ ] **Step 2: Run harness test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/pi-sdk-harness.test.ts
```

Expected: FAIL because delimiters do not match.

- [ ] **Step 3: Update `resolvedSkillInstructions`**

Modify `src/v2/harness/pi-sdk-harness.ts`:

```ts
function resolvedSkillInstructions(skills: Array<{ skillId: string; version?: string; instructions: string }>): string[] {
  if (skills.length === 0) return [];
  return [
    "",
    "=== SKILL INSTRUCTIONS ===",
    ...skills.map((skill) => [
      `## ${skill.skillId}${skill.version ? `@${skill.version}` : ""}`,
      skill.instructions.trim(),
    ].join("\n\n")),
    "=== END SKILL INSTRUCTIONS ===",
    "",
  ];
}
```

- [ ] **Step 4: Run harness test**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/pi-sdk-harness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/harness/pi-sdk-harness.ts tests/v2/pi-sdk-harness.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: delimit injected skill instructions"
```

---

### Task 8: Wire New Tests Into Suite

**Files:**
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Add imports**

Modify `tests/v2/index.test.ts` to include:

```ts
await import("./skill-library.test.ts");
await import("./skill-repair-guidance.test.ts");
```

Place them near the existing `skills.test.ts` import.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git --git-dir=.git-local --work-tree=. add tests/v2/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "test: include skill library tests"
```

---

### Task 9: Strengthen Real Non-Calc E2E Acceptance

**Files:**
- Modify: `tests/e2e-real/design-library-template-real.test.ts`
- Modify: `tests/e2e-real/scenarios/design-library-template-real.ts`

- [ ] **Step 1: Add failing E2E skill assertions**

In `tests/e2e-real/scenarios/design-library-template-real.ts`, after the existing `await waitForRunStatus(context.db, run.runId, ["passed", "completed"], 120_000);` line, add helper calls:

```ts
    assertSkillSnapshotsMaterialized(context.db, run.runId, "checker", [
      "software-dev.skill.artifact-generator-base",
      "software-dev.skill.checker-verification",
    ]);
    assertCheckerArtifactEvidenceAccepted(context.db, run.runId);
```

Add helper functions in the same file:

```ts
function assertSkillSnapshotsMaterialized(db: ReturnType<typeof createScenarioContext>["db"], runId: string, taskId: string, expectedSkillIds: string[]): void {
  const envelopeRow = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'task_envelope' and run_id = ? and task_id = ?
    order by updated_at desc limit 1
  `).get(runId, taskId) as { payload_json: string } | undefined;
  assert.ok(envelopeRow, `missing task envelope for ${runId}/${taskId}`);
  const envelope = JSON.parse(envelopeRow.payload_json) as { skills?: Array<{ skillId?: string; instructions?: string }> };
  const skillIds = (envelope.skills ?? []).map((skill) => skill.skillId);
  for (const expected of expectedSkillIds) {
    assert.equal(skillIds.includes(expected), true, `missing skill ${expected}`);
    const skill = (envelope.skills ?? []).find((candidate) => candidate.skillId === expected);
    assert.equal(typeof skill?.instructions === "string" && skill.instructions.length > 100, true, `skill ${expected} instructions too small`);
  }
}

function assertCheckerArtifactEvidenceAccepted(db: ReturnType<typeof createScenarioContext>["db"], runId: string): void {
  const artifactRow = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'artifact' and run_id = ? and task_id = 'checker'
    order by updated_at desc limit 1
  `).get(runId) as { payload_json: string } | undefined;
  assert.ok(artifactRow, `missing checker artifact for ${runId}`);
  const artifactPayload = JSON.parse(artifactRow.payload_json) as { artifact?: Record<string, unknown>; artifactRef?: { status?: string } };
  const artifact = artifactPayload.artifact ?? artifactPayload;
  for (const field of ["summary", "commandsRun", "testResults", "checkerFindings", "risks"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(artifact, field), true, `checker artifact missing ${field}`);
  }

  const evidenceRow = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'evidence_packet' and run_id = ? and task_id = 'checker'
    order by updated_at desc limit 1
  `).get(runId) as { payload_json: string } | undefined;
  assert.ok(evidenceRow, `missing checker evidence packet for ${runId}`);
  const evidence = JSON.parse(evidenceRow.payload_json) as { evidenceItems?: Array<{ kind?: string; status?: string }> };
  assert.equal(evidence.evidenceItems?.some((item) => item.kind === "command-output" && item.status === "present"), true);
  assert.equal(evidence.evidenceItems?.some((item) => item.kind === "test-result" && item.status === "present"), true);
}
```

- [ ] **Step 2: Strengthen source guards**

In `tests/e2e-real/design-library-template-real.test.ts`, keep existing guards and add:

```ts
  assert.equal(/artifactEvidenceValidatorGoalPrompt|prepareSoftwareFixtureRepo|assertFixtureTests/.test(source), false, "new E2E must not use calc/software fixture helpers");
```

- [ ] **Step 3: Run real E2E only when local Tork is ready**

Run:

```bash
TORK_BASE_URL=http://localhost:8000 SOUTHSTAR_DB=/tmp/southstar-e2e-test.db npm run test:e2e:design-library-real
```

Expected after implementation: PASS. Before implementation completes, this may fail at missing skills or checker artifact evidence; that failure confirms the assertions are active.

- [ ] **Step 4: Commit**

```bash
git --git-dir=.git-local --work-tree=. add tests/e2e-real/design-library-template-real.test.ts tests/e2e-real/scenarios/design-library-template-real.ts
git --git-dir=.git-local --work-tree=. commit -m "test: require real skill-backed design library e2e"
```

---

### Task 10: Full Verification and Final Audit

**Files:**
- No source edits unless verification exposes a defect.

- [ ] **Step 1: Run unit suite**

Run:

```bash
npm test
```

Expected: exit 0.

- [ ] **Step 2: Run real non-calc Design Library E2E**

Run:

```bash
TORK_BASE_URL=http://localhost:8000 SOUTHSTAR_DB=/tmp/southstar-e2e-test.db npm run test:e2e:design-library-real
```

Expected: exit 0.

- [ ] **Step 3: Collect quantitative evidence from SQLite**

Run:

```bash
sqlite3 /tmp/southstar-e2e-test.db "
select count(*) from library_objects where object_kind = 'skill_spec';
select count(*) from runtime_resources where resource_type = 'skill_snapshot';
select task_id, json_array_length(json_extract(payload_json, '$.skills')) as skill_count
from runtime_resources
where resource_type = 'task_envelope'
order by updated_at desc
limit 5;
"
```

Expected:

```text
6 or greater
10 or greater
checker|2 or greater
implementer|2 or greater
planner|2 or greater
explorer|2 or greater
summarizer|2 or greater
```

- [ ] **Step 4: Verify checker evidence**

Run:

```bash
sqlite3 /tmp/southstar-e2e-test.db "
select json_extract(payload_json, '$.completeness.missingKinds')
from runtime_resources
where resource_type = 'evidence_packet' and task_id = 'checker'
order by updated_at desc limit 1;
"
```

Expected:

```text
[]
```

- [ ] **Step 5: Final commit if verification required fixes**

If Task 10 required source fixes, commit them:

```bash
git --git-dir=.git-local --work-tree=. add <changed-files>
git --git-dir=.git-local --work-tree=. commit -m "fix: complete skill library verification"
```

If no fixes were needed, no commit is required.

---

## Plan Self-Review

Spec coverage:
- `skill_spec` first-class library object: Tasks 1 and 2.
- Existing skill runtime reuse: Tasks 3 and 5.
- Base + specialized skills: Tasks 2 and 3.
- Runtime-resolved base dependency, no agent `cat`: Tasks 3 and 5.
- Structured repair instruction from skill metadata: Task 6.
- Pi prompt injection: Task 7.
- Todo-web non-calc real E2E: Task 9 and Task 10.
- Quantitative acceptance standards: top section and Task 10.

Placeholder scan:
- No TBD/TODO placeholders are present.
- Every task has exact files, commands, and expected outcomes.

Type consistency:
- `SkillFieldGuidance`, `SkillRepairGuidance`, and `SkillSpecPayload` are defined in Task 1 and reused in later tasks.
- `fieldGuidance` and `repairGuidance` names are consistent across skill seed, resolver, snapshots, and repair tests.
