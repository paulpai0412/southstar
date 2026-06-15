# Artifact Evidence Validator Real E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build artifact/evidence/validator hardening so real Tork/Docker workflow runs accept artifacts only after required evidence and blocking validators pass, then provide downstream task context from accepted artifact/evidence summaries.

**Architecture:** Keep Southstar's small-table runtime principle by storing artifact lifecycle, evidence packets, validator results, and downstream readiness as typed `runtime_resources`. Add deterministic artifact acceptance services used by Tork callback ingestion, and add a context refresh path so downstream containers can receive latest accepted upstream artifact/evidence summaries at task start. Verification uses a real fixture repo, real Docker/Tork execution, real npm commands, and quantitative gates; no stubbed executor, no stubbed harness, no placeholder scenario.

**Tech Stack:** Node 22 native TypeScript/ESM, SQLite via `node:sqlite`, `node:test`, Docker/Tork, existing Southstar v2 runtime and real E2E harness.

---

## Scope and Constraints

This plan implements the first high-trust runtime slice from `docs/superpowers/specs/2026-06-15-southstar-llm-design-library-workflow-template-design.md`, focused on artifact/evidence/validator hardening and downstream context flow. It does not implement the full Design Library or full visual DAG editor.

Hard requirements from the user:

- Include a real goal prompt in E2E.
- Include real test cases that execute the actual fixture repository and real Docker/Tork path.
- Do not use stubbed executor, stubbed harness, placeholder run, or shallow health-only test as acceptance evidence.
- Define quantitative acceptance criteria.

Quantitative acceptance criteria for this plan:

1. Real E2E scenario completes one Tork-backed run in `<= 15 minutes`.
2. The run reaches `passed` or `completed`.
3. Completed task count is `>= 4` and every completed task has exactly one accepted `artifact` resource.
4. Accepted artifact count equals evidence packet count for the run.
5. Each evidence packet has `completeness.presentCount >= completeness.requiredCount` and `missingKinds.length === 0`.
6. Blocking validator results for accepted artifacts are all `passed`; failed blocking validator count is `0`.
7. Terminal run has at least one `stop_condition_result` with status `passed`.
8. Downstream readiness reports no blocker for every completed task.
9. The real fixture repo passes `npm test` inside `southstar/pi-agent:local`.
10. The real CLI outputs exactly: `sum 1 2 3 -> 6`, `sum -2 5 0.5 -> 3.5`, invalid input exits non-zero and names the invalid value.
11. No `runtime_resources.payload_json` for `artifact`, `evidence_packet`, or `validator_result` exceeds `50000` bytes.

---

## File Structure

Create focused runtime artifact modules:

- Create `src/v2/artifacts/types.ts`  
  Defines runtime artifact, evidence packet, validator result, downstream readiness, and summary types.

- Create `src/v2/artifacts/evidence.ts`  
  Builds evidence packets from artifact payload, task contract, workspace resource refs, command/test outputs, and human/policy evidence.

- Create `src/v2/artifacts/validator-results.ts`  
  Converts schema/evidence/policy/test checks into typed validator result resources.

- Create `src/v2/artifacts/acceptance.ts`  
  Owns artifact lifecycle transitions and persists `artifact`, `evidence_packet`, `validator_result`, and `downstream_readiness` resources.

- Create `src/v2/artifacts/downstream-readiness.ts`  
  Computes whether a task's dependencies have accepted artifacts/evidence matching edge requirements.

- Create `src/v2/artifacts/context-refresh.ts`  
  Builds an updated task `ContextPacket` from accepted upstream artifact/evidence summaries.

Modify existing runtime integration:

- Modify `src/v2/executor/tork-callback.ts`  
  Replace direct artifact acceptance with `acceptTaskRunArtifact`, persist typed evidence/validator results, and update run/task status from acceptance verdict.

- Modify `src/v2/harness/pi-sdk-harness.ts` and `src/v2/agent-runner/cli.ts`  
  Fetch a refreshed context packet at task start when `SOUTHSTAR_CONTEXT_REFRESH_URL` is present, then render agent prompt from refreshed context.

- Modify `src/v2/ui-api/local-api.ts`  
  Add environment variables for context refresh URL into Tork task env and add helper to build task context from accepted upstream artifacts.

- Modify `src/v2/ui-api/read-models.ts` or create `src/v2/ui-api/page-models/artifact-flow.ts`  
  Provide read models for artifact flow, evidence ledger, validator results, and downstream readiness.

Add tests:

- Create `tests/v2/artifact-evidence-validator.test.ts`  
  Runs deterministic real SQLite and real fixture command evidence checks without stubbed executor.

- Modify `tests/v2/index.test.ts`  
  Import the new test.

- Create `tests/e2e-real/scenarios/artifact-evidence-validator-real.ts`  
  Runs a real Tork/Docker software goal and asserts quantitative evidence criteria.

- Modify `tests/e2e-real/scenarios/harness.ts`  
  Add real evidence assertion helpers and a real goal prompt for this scenario.

- Modify `tests/e2e-real/index.test.ts`  
  Include the new scenario in the real E2E suite.

---

## Task 1: Runtime Artifact Types

**Files:**
- Create: `src/v2/artifacts/types.ts`
- Test: `tests/v2/artifact-evidence-validator.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing type-shape test**

Add this new test file:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type {
  EvidencePacket,
  RuntimeArtifactRef,
  ValidatorResult,
} from "../../src/v2/artifacts/types.ts";

test("runtime artifact, evidence packet, and validator result types support accepted artifact gating", () => {
  const artifact: RuntimeArtifactRef = {
    id: "artifact-run-1-task-1",
    runId: "run-1",
    taskId: "task-1",
    artifactType: "implementation-report",
    contractRef: "implementation_report",
    producerAgentSpecRef: "software-maker-pi",
    producerAttemptId: "attempt-1",
    status: "accepted",
    summary: "Implemented calc sum and verified tests.",
    evidencePacketRefs: ["evidence-run-1-task-1"],
    validatorResultRefs: ["validator-run-1-task-1-schema"],
    createdAt: "2026-06-15T00:00:00.000Z",
    acceptedAt: "2026-06-15T00:00:01.000Z",
  };

  const evidence: EvidencePacket = {
    schemaVersion: "southstar.runtime.evidence_packet.v1",
    id: "evidence-run-1-task-1",
    runId: "run-1",
    taskId: "task-1",
    artifactRef: artifact.id,
    evidenceItems: [{
      kind: "test-result",
      status: "present",
      summary: "npm test passed",
      sourceRef: "artifact.testResults[0]",
      capturedAt: "2026-06-15T00:00:00.500Z",
      reproducibleCommand: ["npm", "test"],
      redactionApplied: true,
    }],
    completeness: { requiredCount: 1, presentCount: 1, missingKinds: [] },
  };

  const validator: ValidatorResult = {
    schemaVersion: "southstar.runtime.validator_result.v1",
    id: "validator-run-1-task-1-schema",
    runId: "run-1",
    taskId: "task-1",
    artifactRef: artifact.id,
    validatorRef: "software-feature-quality:schema",
    validatorType: "schema",
    verdict: "passed",
    blocking: true,
    checkedContractRefs: ["implementation_report"],
    checkedEvidenceRefs: [evidence.id],
    messages: [],
    createdAt: "2026-06-15T00:00:00.750Z",
  };

  assert.equal(artifact.status, "accepted");
  assert.equal(evidence.completeness.missingKinds.length, 0);
  assert.equal(validator.verdict, "passed");
});
```

Add the import to `tests/v2/index.test.ts` near the other artifact/evaluator tests:

```ts
await import("./artifact-evidence-validator.test.ts");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: fail with an import error for `../../src/v2/artifacts/types.ts`.

- [ ] **Step 3: Add artifact runtime types**

Create `src/v2/artifacts/types.ts`:

```ts
export type ArtifactLifecycleStatus =
  | "created"
  | "schema_validated"
  | "evidence_validated"
  | "policy_validated"
  | "accepted"
  | "rejected"
  | "needs_repair";

export type EvidenceKind =
  | "file-diff"
  | "test-result"
  | "command-output"
  | "url"
  | "screenshot"
  | "human-approval"
  | "artifact-ref"
  | "workspace-snapshot"
  | "policy-decision";

export type EvidenceItemStatus = "present" | "missing" | "invalid" | "stale";

export type RuntimeArtifactRef = {
  id: string;
  runId: string;
  taskId: string;
  artifactType: string;
  contractRef: string;
  producerAgentSpecRef: string;
  producerAttemptId: string;
  status: ArtifactLifecycleStatus;
  summary: string;
  payloadResourceRef?: string;
  blobRef?: string;
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
  createdAt: string;
  acceptedAt?: string;
};

export type EvidencePacket = {
  schemaVersion: "southstar.runtime.evidence_packet.v1";
  id: string;
  runId: string;
  taskId: string;
  artifactRef: string;
  evidenceItems: Array<{
    kind: EvidenceKind;
    status: EvidenceItemStatus;
    summary: string;
    sourceRef?: string;
    sha256?: string;
    capturedAt: string;
    reproducibleCommand?: string[];
    redactionApplied: boolean;
  }>;
  completeness: {
    requiredCount: number;
    presentCount: number;
    missingKinds: string[];
  };
};

export type ValidatorResult = {
  schemaVersion: "southstar.runtime.validator_result.v1";
  id: string;
  runId: string;
  taskId?: string;
  artifactRef?: string;
  validatorRef: string;
  validatorType: "schema" | "test" | "policy" | "checker-agent" | "human" | "pipeline" | "custom";
  verdict: "passed" | "failed" | "warning" | "skipped";
  blocking: boolean;
  checkedContractRefs: string[];
  checkedEvidenceRefs: string[];
  messages: Array<{ severity: "info" | "warning" | "error"; path?: string; text: string }>;
  metrics?: Record<string, number>;
  rerunCommand?: string[];
  repairHint?: string;
  createdAt: string;
};

export type DownstreamReadiness = {
  schemaVersion: "southstar.runtime.downstream_readiness.v1";
  runId: string;
  taskId: string;
  ready: boolean;
  blockers: Array<{
    dependencyTaskId: string;
    missingArtifactContractRefs: string[];
    missingEvidenceKinds: string[];
    workspaceStateRequired: boolean;
    workspaceReady: boolean;
  }>;
  checkedAt: string;
};

export type ArtifactEvidenceSummary = {
  artifactRef: string;
  artifactType: string;
  contractRef: string;
  taskId: string;
  status: ArtifactLifecycleStatus;
  summary: string;
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
};
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/artifacts/types.ts tests/v2/artifact-evidence-validator.test.ts tests/v2/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: add runtime artifact evidence types"
```

---

## Task 2: Evidence Packet Builder

**Files:**
- Create: `src/v2/artifacts/evidence.ts`
- Modify: `tests/v2/artifact-evidence-validator.test.ts`

- [ ] **Step 1: Add failing tests for real evidence extraction**

Append to `tests/v2/artifact-evidence-validator.test.ts`:

```ts
import { buildEvidencePacket } from "../../src/v2/artifacts/evidence.ts";

test("builds complete evidence packet from real command and test result artifact fields", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "implement-feature",
    artifactRef: "artifact-run-1-implement-feature",
    requiredEvidenceKinds: ["test-result", "command-output"],
    artifact: {
      summary: "Implemented calc sum.",
      commandsRun: ["npm test", "npm run -s cli -- sum 1 2 3"],
      testResults: [
        { command: "npm test", status: "passed", output: "4 tests passed" },
        { command: "npm run -s cli -- sum 1 2 3", status: "passed", output: "6" },
      ],
      artifactEvidence: {
        testResults: [{ command: "npm test", status: "passed", output: "4 tests passed" }],
      },
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(packet.schemaVersion, "southstar.runtime.evidence_packet.v1");
  assert.deepEqual(packet.completeness, { requiredCount: 2, presentCount: 2, missingKinds: [] });
  assert.equal(packet.evidenceItems.some((item) => item.kind === "test-result" && item.status === "present"), true);
  assert.equal(packet.evidenceItems.some((item) => item.kind === "command-output" && item.status === "present"), true);
  assert.equal(packet.evidenceItems.every((item) => item.redactionApplied), true);
});

test("marks required evidence missing when artifact omits real test output", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "implement-feature",
    artifactRef: "artifact-run-1-implement-feature",
    requiredEvidenceKinds: ["test-result", "file-diff"],
    artifact: { summary: "No evidence yet", commandsRun: [] },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(packet.completeness.requiredCount, 2);
  assert.equal(packet.completeness.presentCount, 0);
  assert.deepEqual(packet.completeness.missingKinds.sort(), ["file-diff", "test-result"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: fail with missing `src/v2/artifacts/evidence.ts`.

- [ ] **Step 3: Implement evidence builder**

Create `src/v2/artifacts/evidence.ts`:

```ts
import { createHash } from "node:crypto";
import type { EvidenceKind, EvidencePacket } from "./types.ts";

export type BuildEvidencePacketInput = {
  runId: string;
  taskId: string;
  artifactRef: string;
  requiredEvidenceKinds: EvidenceKind[];
  artifact: Record<string, unknown>;
  now?: string;
};

export function buildEvidencePacket(input: BuildEvidencePacketInput): EvidencePacket {
  const now = input.now ?? new Date().toISOString();
  const present = new Map<EvidenceKind, EvidencePacket["evidenceItems"][number]>();

  const commandEvidence = commandOutputEvidence(input.artifact, now);
  if (commandEvidence) present.set("command-output", commandEvidence);

  const testEvidence = testResultEvidence(input.artifact, now);
  if (testEvidence) present.set("test-result", testEvidence);

  const diffEvidence = fileDiffEvidence(input.artifact, now);
  if (diffEvidence) present.set("file-diff", diffEvidence);

  const artifactRefEvidence = artifactRefEvidenceItem(input.artifact, now);
  if (artifactRefEvidence) present.set("artifact-ref", artifactRefEvidence);

  const required = [...new Set(input.requiredEvidenceKinds)];
  const evidenceItems = required.map((kind) => present.get(kind) ?? missingEvidence(kind, now));
  const presentCount = evidenceItems.filter((item) => item.status === "present").length;
  return {
    schemaVersion: "southstar.runtime.evidence_packet.v1",
    id: `evidence-${input.runId}-${input.taskId}-${shortHash(`${input.artifactRef}:${required.join(",")}`)}`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    evidenceItems,
    completeness: {
      requiredCount: required.length,
      presentCount,
      missingKinds: evidenceItems.filter((item) => item.status !== "present").map((item) => item.kind),
    },
  };
}

function commandOutputEvidence(artifact: Record<string, unknown>, now: string): EvidencePacket["evidenceItems"][number] | undefined {
  const command = firstCommandResult(artifact.testResults) ?? firstCommandResult((artifact.artifactEvidence as { testResults?: unknown })?.testResults);
  if (!command) return undefined;
  return {
    kind: "command-output",
    status: passedCommand(command) ? "present" : "invalid",
    summary: summarizeCommand(command),
    sourceRef: "artifact.testResults",
    sha256: shortHash(JSON.stringify(command)),
    capturedAt: now,
    reproducibleCommand: splitCommand(command.command),
    redactionApplied: true,
  };
}

function testResultEvidence(artifact: Record<string, unknown>, now: string): EvidencePacket["evidenceItems"][number] | undefined {
  const command = firstCommandResult(artifact.testResults) ?? firstCommandResult((artifact.artifactEvidence as { testResults?: unknown })?.testResults);
  if (!command) return undefined;
  return {
    kind: "test-result",
    status: passedCommand(command) ? "present" : "invalid",
    summary: summarizeCommand(command),
    sourceRef: "artifact.testResults",
    sha256: shortHash(JSON.stringify(command)),
    capturedAt: now,
    reproducibleCommand: splitCommand(command.command),
    redactionApplied: true,
  };
}

function fileDiffEvidence(artifact: Record<string, unknown>, now: string): EvidencePacket["evidenceItems"][number] | undefined {
  const filesChanged = Array.isArray(artifact.filesChanged) ? artifact.filesChanged.filter((item) => typeof item === "string") : [];
  if (filesChanged.length === 0) return undefined;
  return {
    kind: "file-diff",
    status: "present",
    summary: `Changed files: ${filesChanged.join(", ")}`,
    sourceRef: "artifact.filesChanged",
    sha256: shortHash(filesChanged.join("\n")),
    capturedAt: now,
    redactionApplied: true,
  };
}

function artifactRefEvidenceItem(artifact: Record<string, unknown>, now: string): EvidencePacket["evidenceItems"][number] | undefined {
  const acceptedArtifacts = Array.isArray(artifact.acceptedArtifacts) ? artifact.acceptedArtifacts.filter((item) => typeof item === "string") : [];
  if (acceptedArtifacts.length === 0) return undefined;
  return {
    kind: "artifact-ref",
    status: "present",
    summary: `Accepted artifacts: ${acceptedArtifacts.join(", ")}`,
    sourceRef: "artifact.acceptedArtifacts",
    sha256: shortHash(acceptedArtifacts.join("\n")),
    capturedAt: now,
    redactionApplied: true,
  };
}

function missingEvidence(kind: EvidenceKind, now: string): EvidencePacket["evidenceItems"][number] {
  return { kind, status: "missing", summary: `Missing required ${kind} evidence.`, capturedAt: now, redactionApplied: true };
}

function firstCommandResult(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
}

function passedCommand(command: Record<string, unknown>): boolean {
  const status = typeof command.status === "string" ? command.status.toLowerCase() : "";
  const result = typeof command.result === "string" ? command.result.toLowerCase() : "";
  if (command.passed === true || command.ok === true) return true;
  if (["passed", "pass", "success", "succeeded", "ok"].includes(status)) return true;
  if (["passed", "pass", "success", "succeeded", "ok"].includes(result)) return true;
  return command.exitCode === 0 || command.code === 0;
}

function summarizeCommand(command: Record<string, unknown>): string {
  const rendered = typeof command.command === "string" ? command.command : "command";
  const output = typeof command.output === "string" ? command.output.slice(0, 200) : "";
  return output ? `${rendered}: ${output}` : rendered;
}

function splitCommand(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(/\s+/).filter(Boolean);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/artifacts/evidence.ts tests/v2/artifact-evidence-validator.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: build evidence packets from artifacts"
```

---

## Task 3: Typed Validator Results and Artifact Acceptance

**Files:**
- Create: `src/v2/artifacts/validator-results.ts`
- Create: `src/v2/artifacts/acceptance.ts`
- Modify: `tests/v2/artifact-evidence-validator.test.ts`

- [ ] **Step 1: Add failing tests for blocking validator gates**

Append to `tests/v2/artifact-evidence-validator.test.ts`:

```ts
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { acceptTaskRunArtifact } from "../../src/v2/artifacts/acceptance.ts";

test("accepts artifact only when required fields and evidence pass", () => {
  const db = openSouthstarDb(":memory:");
  const result = acceptTaskRunArtifact(db, {
    runId: "run-accept",
    taskId: "implement-feature",
    rootSessionId: "session-1",
    attempts: 1,
    producerAgentSpecRef: "software-maker-pi",
    artifactContract: {
      id: "implementation_report",
      artifactType: "implementation-report",
      requiredFields: ["summary", "filesChanged", "commandsRun", "testResults", "risks", "artifactEvidence"],
      evidenceFields: ["filesChanged", "commandsRun", "testResults", "artifactEvidence"],
    },
    requiredEvidenceKinds: ["file-diff", "test-result", "command-output"],
    artifact: {
      summary: "Implemented calc sum.",
      filesChanged: ["src/cli.js", "test/cli.test.js", "README.md"],
      commandsRun: ["npm test", "npm run -s cli -- sum 1 2 3"],
      testResults: [{ command: "npm test", status: "passed", output: "4 tests passed" }],
      risks: [],
      artifactEvidence: { testResults: [{ command: "npm test", status: "passed", output: "4 tests passed" }] },
    },
    metrics: { tokens: 128, costMicrosUsd: 0 },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(result.accepted, true);
  assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
  assert.equal(listResources(db, { resourceType: "evidence_packet", status: "complete" }).length, 1);
  assert.equal(listResources(db, { resourceType: "validator_result", status: "passed" }).length >= 3, true);
});

test("keeps artifact in needs_repair when required evidence is missing", () => {
  const db = openSouthstarDb(":memory:");
  const result = acceptTaskRunArtifact(db, {
    runId: "run-repair",
    taskId: "implement-feature",
    rootSessionId: "session-1",
    attempts: 1,
    producerAgentSpecRef: "software-maker-pi",
    artifactContract: {
      id: "implementation_report",
      artifactType: "implementation-report",
      requiredFields: ["summary", "commandsRun", "testResults"],
      evidenceFields: ["commandsRun", "testResults"],
    },
    requiredEvidenceKinds: ["test-result", "file-diff"],
    artifact: { summary: "No tests", commandsRun: [], testResults: [] },
    metrics: { tokens: 128, costMicrosUsd: 0 },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "needs_repair");
  assert.equal(listResources(db, { resourceType: "artifact", status: "needs_repair" }).length, 1);
  const failed = listResources(db, { resourceType: "validator_result", status: "failed" });
  assert.equal(failed.some((resource) => JSON.stringify(resource.payload).includes("Missing required file-diff evidence")), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: fail with missing `acceptance.ts`.

- [ ] **Step 3: Implement validator result helpers**

Create `src/v2/artifacts/validator-results.ts`:

```ts
import type { ArtifactContract } from "../domain-packs/types.ts";
import type { EvidencePacket, ValidatorResult } from "./types.ts";

export function schemaValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contract: ArtifactContract;
  artifact: Record<string, unknown>;
  now?: string;
}): ValidatorResult {
  const messages = input.contract.requiredFields
    .filter((field) => !hasRequiredValue(input.artifact[field]))
    .map((field) => ({ severity: "error" as const, path: field, text: `Missing required field ${field}` }));
  return {
    schemaVersion: "southstar.runtime.validator_result.v1",
    id: `validator-${input.runId}-${input.taskId}-${input.contract.id}-schema`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contract.id}:schema`,
    validatorType: "schema",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contract.id],
    checkedEvidenceRefs: [],
    messages,
    repairHint: messages.length === 0 ? undefined : `Return artifact fields: ${input.contract.requiredFields.join(", ")}`,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function evidenceValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contractRef: string;
  evidence: EvidencePacket;
  now?: string;
}): ValidatorResult {
  const messages = input.evidence.completeness.missingKinds.map((kind) => ({
    severity: "error" as const,
    path: `evidence.${kind}`,
    text: `Missing required ${kind} evidence`,
  }));
  const invalidMessages = input.evidence.evidenceItems
    .filter((item) => item.status === "invalid" || item.status === "stale")
    .map((item) => ({ severity: "error" as const, path: `evidence.${item.kind}`, text: `Invalid ${item.kind} evidence: ${item.summary}` }));
  const allMessages = [...messages, ...invalidMessages];
  return {
    schemaVersion: "southstar.runtime.validator_result.v1",
    id: `validator-${input.runId}-${input.taskId}-${input.contractRef}-evidence`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contractRef}:evidence`,
    validatorType: "custom",
    verdict: allMessages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contractRef],
    checkedEvidenceRefs: [input.evidence.id],
    messages: allMessages,
    repairHint: allMessages.length === 0 ? undefined : "Provide required evidence in artifactEvidence, testResults, filesChanged, or commandsRun.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function policyValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contractRef: string;
  artifact: Record<string, unknown>;
  now?: string;
}): ValidatorResult {
  const serialized = JSON.stringify(input.artifact);
  const messages = tokenLeakMessages(serialized);
  return {
    schemaVersion: "southstar.runtime.validator_result.v1",
    id: `validator-${input.runId}-${input.taskId}-${input.contractRef}-policy`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contractRef}:policy`,
    validatorType: "policy",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contractRef],
    checkedEvidenceRefs: [],
    messages,
    repairHint: messages.length === 0 ? undefined : "Remove secret-shaped values and raw transcripts from artifact payload.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}

function hasRequiredValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}

function tokenLeakMessages(serialized: string): ValidatorResult["messages"] {
  if (/sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(serialized)) {
    return [{ severity: "error", path: "artifact", text: "Artifact payload contains token-shaped or private-key-shaped value" }];
  }
  if (serialized.length > 50_000) {
    return [{ severity: "error", path: "artifact", text: "Artifact payload exceeds 50000 byte compact history limit" }];
  }
  return [];
}
```

- [ ] **Step 4: Implement artifact acceptance service**

Create `src/v2/artifacts/acceptance.ts`:

```ts
import type { ArtifactContract } from "../domain-packs/types.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { buildEvidencePacket } from "./evidence.ts";
import type { ArtifactLifecycleStatus, EvidenceKind, RuntimeArtifactRef, ValidatorResult } from "./types.ts";
import { evidenceValidatorResult, policyValidatorResult, schemaValidatorResult } from "./validator-results.ts";

export type AcceptTaskRunArtifactInput = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  attempts: number;
  producerAgentSpecRef: string;
  artifactContract: ArtifactContract;
  requiredEvidenceKinds: EvidenceKind[];
  artifact: Record<string, unknown>;
  metrics: unknown;
  now?: string;
};

export type AcceptTaskRunArtifactResult = {
  artifactResourceId: string;
  evidencePacketId: string;
  validatorResultIds: string[];
  accepted: boolean;
  status: ArtifactLifecycleStatus;
  blockingFailures: ValidatorResult[];
};

export function acceptTaskRunArtifact(db: SouthstarDb, input: AcceptTaskRunArtifactInput): AcceptTaskRunArtifactResult {
  const now = input.now ?? new Date().toISOString();
  const artifactResourceId = `artifact-${input.runId}-${input.taskId}-callback`;
  const evidence = buildEvidencePacket({
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: artifactResourceId,
    requiredEvidenceKinds: input.requiredEvidenceKinds,
    artifact: input.artifact,
    now,
  });
  const validators = [
    schemaValidatorResult({ runId: input.runId, taskId: input.taskId, artifactRef: artifactResourceId, contract: input.artifactContract, artifact: input.artifact, now }),
    evidenceValidatorResult({ runId: input.runId, taskId: input.taskId, artifactRef: artifactResourceId, contractRef: input.artifactContract.id, evidence, now }),
    policyValidatorResult({ runId: input.runId, taskId: input.taskId, artifactRef: artifactResourceId, contractRef: input.artifactContract.id, artifact: input.artifact, now }),
  ];
  const blockingFailures = validators.filter((validator) => validator.blocking && validator.verdict === "failed");
  const status: ArtifactLifecycleStatus = blockingFailures.length === 0 ? "accepted" : "needs_repair";

  upsertRuntimeResource(db, {
    id: evidence.id,
    resourceType: "evidence_packet",
    resourceKey: evidence.id,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.rootSessionId,
    scope: "task",
    status: evidence.completeness.missingKinds.length === 0 ? "complete" : "incomplete",
    title: `Evidence for ${input.taskId}`,
    payload: evidence,
    summary: evidence.completeness,
  });

  const validatorResultIds: string[] = [];
  for (const validator of validators) {
    validatorResultIds.push(validator.id);
    upsertRuntimeResource(db, {
      id: validator.id,
      resourceType: "validator_result",
      resourceKey: validator.id,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.rootSessionId,
      scope: "task",
      status: validator.verdict,
      title: validator.validatorRef,
      payload: validator,
      summary: { verdict: validator.verdict, blocking: validator.blocking, messageCount: validator.messages.length, repairHint: validator.repairHint },
    });
  }

  const artifactRef: RuntimeArtifactRef = {
    id: artifactResourceId,
    runId: input.runId,
    taskId: input.taskId,
    artifactType: input.artifactContract.artifactType,
    contractRef: input.artifactContract.id,
    producerAgentSpecRef: input.producerAgentSpecRef,
    producerAttemptId: `attempt-${input.attempts}`,
    status,
    summary: typeof input.artifact.summary === "string" ? input.artifact.summary : `${input.taskId} artifact`,
    payloadResourceRef: artifactResourceId,
    evidencePacketRefs: [evidence.id],
    validatorResultRefs: validatorResultIds,
    createdAt: now,
    acceptedAt: status === "accepted" ? now : undefined,
  };

  upsertRuntimeResource(db, {
    id: artifactResourceId,
    resourceType: "artifact",
    resourceKey: artifactResourceId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.rootSessionId,
    scope: "task",
    status,
    title: status === "accepted" ? "Accepted callback artifact" : "Artifact needs repair",
    payload: { artifact: input.artifact, artifactRef },
    summary: artifactRef,
    metrics: input.metrics,
  });

  return {
    artifactResourceId,
    evidencePacketId: evidence.id,
    validatorResultIds,
    accepted: status === "accepted",
    status,
    blockingFailures,
  };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/artifacts/validator-results.ts src/v2/artifacts/acceptance.ts tests/v2/artifact-evidence-validator.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: gate artifacts with evidence validators"
```

---

## Task 4: Integrate Artifact Acceptance into Tork Callback

**Files:**
- Modify: `src/v2/executor/tork-callback.ts`
- Modify: `tests/v2/tork-callback.test.ts`

- [ ] **Step 1: Add failing callback ingestion test**

In `tests/v2/tork-callback.test.ts`, add a test that creates a real run row, workflow manifest, and ingests a callback result with missing evidence. Use the existing helpers in the file where possible. Add this assertion body near existing callback ingestion tests:

```ts
test("callback ingestion does not accept artifact when evidence validators fail", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-evidence-callback",
    taskId: "implement-feature",
    requiredArtifactRef: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });

  ingestTaskRunResult(db, {
    runId: "run-evidence-callback",
    taskId: "implement-feature",
    rootSessionId: "root-run-evidence-callback-implement-feature",
    ok: true,
    attempts: 1,
    artifact: { summary: "missing test evidence", commandsRun: [], testResults: [] },
    metrics: { tokens: 128, costMicrosUsd: 0 },
    events: [],
  });

  const artifact = listResources(db, { resourceType: "artifact" })[0];
  assert.equal(artifact.status, "needs_repair");
  assert.equal(listResources(db, { resourceType: "evidence_packet", status: "incomplete" }).length, 1);
  assert.equal(listResources(db, { resourceType: "validator_result", status: "failed" }).length >= 1, true);
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get("run-evidence-callback", "implement-feature") as { status: string };
  assert.equal(task.status, "failed");
});
```

If `seedRunWithWorkflow` does not exist, add it to the test file with concrete inserts using `createWorkflowRun` and `createWorkflowTask` from existing stores. The manifest must include `softwareDomainPack.artifactContracts` and `softwareDomainPack.evaluatorPipelines`.

- [ ] **Step 2: Run callback test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/tork-callback.test.ts
```

Expected: fail because current callback ingestion marks `result.ok` artifact accepted before evidence gating.

- [ ] **Step 3: Modify callback ingestion to use acceptance service**

In `src/v2/executor/tork-callback.ts`:

1. Import the acceptance service and evidence kind type:

```ts
import { acceptTaskRunArtifact } from "../artifacts/acceptance.ts";
import type { EvidenceKind } from "../artifacts/types.ts";
```

2. Replace the direct `upsertRuntimeResource` artifact block with:

```ts
    const acceptance = acceptTaskRunArtifact(db, {
      runId: result.runId,
      taskId: result.taskId,
      rootSessionId: result.rootSessionId,
      attempts: result.attempts,
      producerAgentSpecRef: producerAgentSpecRef(db, result.runId, result.taskId),
      artifactContract: taskArtifactContract(db, result.runId, result.taskId),
      requiredEvidenceKinds: requiredEvidenceKindsForTask(db, result.runId, result.taskId),
      artifact: result.artifact,
      metrics: result.metrics,
    });
    const artifactResourceId = acceptance.artifactResourceId;
```

3. Change later checks from `if (result.ok)` to `if (acceptance.accepted)`.

4. Change `updateTaskStatus` to:

```ts
    updateTaskStatus(db, result.runId, result.taskId, acceptance.accepted ? "completed" : "failed");
```

5. Add helper functions at the end of `tork-callback.ts`:

```ts
function producerAgentSpecRef(db: SouthstarDb, runId: string, taskId: string): string {
  const workflow = readWorkflowManifest(db, runId);
  const task = workflow?.tasks.find((candidate) => candidate.id === taskId);
  return task?.agentProfileRef ?? task?.subagents[0]?.id ?? "unknown-agent";
}

function taskArtifactContract(db: SouthstarDb, runId: string, taskId: string): ArtifactContract {
  const workflow = readWorkflowManifest(db, runId);
  const task = workflow?.tasks.find((candidate) => candidate.id === taskId);
  if (!workflow || !task) throw new Error(`missing workflow task ${runId}/${taskId}`);
  const artifactRef = task.requiredArtifactRefs?.[0] ?? task.subagents[0]?.requiredArtifacts[0];
  const contract = artifactRef ? findArtifactContract(workflow, artifactRef) : undefined;
  if (!contract) throw new Error(`missing artifact contract for ${runId}/${taskId}`);
  return contract;
}

function requiredEvidenceKindsForTask(db: SouthstarDb, runId: string, taskId: string): EvidenceKind[] {
  const contract = taskArtifactContract(db, runId, taskId);
  const kinds = new Set<EvidenceKind>();
  for (const field of contract.evidenceFields) {
    if (field === "filesChanged") kinds.add("file-diff");
    if (field === "commandsRun") kinds.add("command-output");
    if (field === "testResults" || field === "tests") kinds.add("test-result");
    if (field === "artifactEvidence") kinds.add("test-result");
    if (field === "acceptedArtifacts") kinds.add("artifact-ref");
  }
  if (kinds.size === 0) kinds.add("artifact-ref");
  return [...kinds];
}
```

- [ ] **Step 4: Run callback tests**

Run:

```bash
npm run test:v2 -- tests/v2/tork-callback.test.ts
```

Expected: pass.

- [ ] **Step 5: Run artifact tests**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/tork-callback.ts tests/v2/tork-callback.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: enforce artifact evidence gates on callback"
```

---

## Task 5: Downstream Readiness and Context Refresh

**Files:**
- Create: `src/v2/artifacts/downstream-readiness.ts`
- Create: `src/v2/artifacts/context-refresh.ts`
- Modify: `src/v2/agent-runner/cli.ts`
- Modify: `src/v2/harness/pi-sdk-harness.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `tests/v2/artifact-evidence-validator.test.ts`

- [ ] **Step 1: Add failing readiness and context tests**

Append to `tests/v2/artifact-evidence-validator.test.ts`:

```ts
import { computeDownstreamReadiness } from "../../src/v2/artifacts/downstream-readiness.ts";
import { buildRefreshedContextSummary } from "../../src/v2/artifacts/context-refresh.ts";

test("downstream readiness requires accepted upstream artifacts", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-run-ready-plan",
    runId: "run-ready",
    taskId: "plan",
    scope: "task",
    status: "accepted",
    title: "Accepted plan",
    payload: { artifact: { summary: "Plan accepted" } },
    summary: {
      id: "artifact-run-ready-plan",
      artifactType: "implementation-plan",
      contractRef: "implementation_plan",
      taskId: "plan",
      status: "accepted",
      summary: "Plan accepted",
      evidencePacketRefs: ["evidence-run-ready-plan"],
      validatorResultRefs: ["validator-run-ready-plan"],
    },
  });

  const readiness = computeDownstreamReadiness(db, {
    runId: "run-ready",
    taskId: "implement",
    dependencies: [{ taskId: "plan", artifactContractRefs: ["implementation_plan"], workspaceStateRequired: false }],
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
});

test("refreshed context summary includes accepted upstream artifact and evidence refs", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-run-context-plan",
    runId: "run-context",
    taskId: "plan",
    scope: "task",
    status: "accepted",
    title: "Accepted plan",
    payload: { artifact: { summary: "Use minimal implementation" } },
    summary: {
      id: "artifact-run-context-plan",
      artifactType: "implementation-plan",
      contractRef: "implementation_plan",
      taskId: "plan",
      status: "accepted",
      summary: "Use minimal implementation",
      evidencePacketRefs: ["evidence-run-context-plan"],
      validatorResultRefs: ["validator-run-context-plan"],
    },
  });

  const summary = buildRefreshedContextSummary(db, {
    runId: "run-context",
    taskId: "implement",
    dependencyTaskIds: ["plan"],
  });

  assert.match(summary.text, /Use minimal implementation/);
  assert.deepEqual(summary.artifactRefs, ["artifact-run-context-plan"]);
  assert.deepEqual(summary.evidencePacketRefs, ["evidence-run-context-plan"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
```

Expected: fail with missing modules.

- [ ] **Step 3: Implement downstream readiness**

Create `src/v2/artifacts/downstream-readiness.ts`:

```ts
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { DownstreamReadiness } from "./types.ts";

export type DownstreamDependencyRequirement = {
  taskId: string;
  artifactContractRefs: string[];
  workspaceStateRequired: boolean;
};

export function computeDownstreamReadiness(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  dependencies: DownstreamDependencyRequirement[];
  now?: string;
}): DownstreamReadiness {
  const artifacts = listResources(db, { resourceType: "artifact" })
    .filter((resource) => resource.runId === input.runId && resource.status === "accepted");
  const blockers = input.dependencies.map((dependency) => {
    const providedContracts = new Set(artifacts
      .filter((resource) => resource.taskId === dependency.taskId)
      .map((resource) => contractRefFromSummary(resource.summary))
      .filter((value): value is string => typeof value === "string"));
    const missingArtifactContractRefs = dependency.artifactContractRefs.filter((contractRef) => !providedContracts.has(contractRef));
    return {
      dependencyTaskId: dependency.taskId,
      missingArtifactContractRefs,
      missingEvidenceKinds: [],
      workspaceStateRequired: dependency.workspaceStateRequired,
      workspaceReady: dependency.workspaceStateRequired ? hasWorkspaceState(db, input.runId, dependency.taskId) : true,
    };
  }).filter((blocker) => blocker.missingArtifactContractRefs.length > 0 || !blocker.workspaceReady);

  const readiness: DownstreamReadiness = {
    schemaVersion: "southstar.runtime.downstream_readiness.v1",
    runId: input.runId,
    taskId: input.taskId,
    ready: blockers.length === 0,
    blockers,
    checkedAt: input.now ?? new Date().toISOString(),
  };
  upsertRuntimeResource(db, {
    resourceType: "downstream_readiness",
    resourceKey: `downstream-readiness-${input.runId}-${input.taskId}`,
    runId: input.runId,
    taskId: input.taskId,
    scope: "workflow",
    status: readiness.ready ? "ready" : "blocked",
    title: `Downstream readiness for ${input.taskId}`,
    payload: readiness,
    summary: { ready: readiness.ready, blockerCount: readiness.blockers.length },
  });
  return readiness;
}

function contractRefFromSummary(summary: unknown): string | undefined {
  return typeof summary === "object" && summary !== null && "contractRef" in summary
    ? (summary as { contractRef?: string }).contractRef
    : undefined;
}

function hasWorkspaceState(db: SouthstarDb, runId: string, taskId: string): boolean {
  return listResources(db, { resourceType: "workspace_snapshot" })
    .some((resource) => resource.runId === runId && resource.taskId === taskId);
}
```

- [ ] **Step 4: Implement context refresh summary**

Create `src/v2/artifacts/context-refresh.ts`:

```ts
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export type RefreshedContextSummary = {
  text: string;
  artifactRefs: string[];
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
};

export function buildRefreshedContextSummary(db: SouthstarDb, input: {
  runId: string;
  taskId: string;
  dependencyTaskIds: string[];
}): RefreshedContextSummary {
  const dependencies = new Set(input.dependencyTaskIds);
  const artifacts = listResources(db, { resourceType: "artifact" })
    .filter((resource) => resource.runId === input.runId && resource.status === "accepted" && resource.taskId && dependencies.has(resource.taskId));
  const summaries = artifacts.map((resource) => {
    const summary = resource.summary as { summary?: string; evidencePacketRefs?: string[]; validatorResultRefs?: string[] };
    return {
      artifactRef: resource.id,
      text: summary.summary ?? resource.title ?? resource.id,
      evidencePacketRefs: summary.evidencePacketRefs ?? [],
      validatorResultRefs: summary.validatorResultRefs ?? [],
    };
  });
  return {
    text: summaries.map((summary) => `Accepted upstream artifact ${summary.artifactRef}: ${summary.text}`).join("\n"),
    artifactRefs: summaries.map((summary) => summary.artifactRef),
    evidencePacketRefs: summaries.flatMap((summary) => summary.evidencePacketRefs),
    validatorResultRefs: summaries.flatMap((summary) => summary.validatorResultRefs),
  };
}
```

- [ ] **Step 5: Add context refresh env parsing in agent runner**

In `src/v2/agent-runner/cli.ts`, extend `parseAgentRunnerArgs` return object with:

```ts
    contextRefreshUrl: flagValue(argv, "--context-refresh-url") ?? env.SOUTHSTAR_CONTEXT_REFRESH_URL,
```

In `createAgentHarness` or immediately after loading `envelope`, before calling `runTaskEnvelope`, add:

```ts
    const refreshedEnvelope = options.contextRefreshUrl
      ? await refreshEnvelopeContext(options.contextRefreshUrl, envelope)
      : envelope;
```

Then pass `refreshedEnvelope` into `runTaskEnvelope` and `startHeartbeatLoop`.

Add helper in the same file:

```ts
async function refreshEnvelopeContext(url: string, envelope: AnyTaskEnvelope): Promise<AnyTaskEnvelope> {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return envelope;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: envelope.runId, taskId: envelope.taskId }),
  });
  if (!response.ok) throw new Error(`context refresh failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { upstreamContext?: { text?: string; artifactRefs?: string[]; evidencePacketRefs?: string[]; validatorResultRefs?: string[] } };
  if (!payload.upstreamContext?.text) return envelope;
  return {
    ...envelope,
    contextPacket: {
      ...envelope.contextPacket,
      priorArtifacts: [
        ...envelope.contextPacket.priorArtifacts,
        {
          id: `upstream-${envelope.runId}-${envelope.taskId}`,
          sourceType: "artifact",
          title: "Accepted upstream artifacts",
          text: payload.upstreamContext.text,
          sourceRef: payload.upstreamContext.artifactRefs?.join(","),
          tokenEstimate: Math.max(1, Math.ceil(payload.upstreamContext.text.length / 4)),
        },
      ],
    },
  };
}
```

- [ ] **Step 6: Thread context refresh URL into Tork tasks**

In `src/v2/ui-api/local-api.ts`, extend `materializedWorkflowForExecution` input type to include `contextRefreshUrl?: string`. Add env when present:

```ts
          ...(input.contextRefreshUrl ? { SOUTHSTAR_CONTEXT_REFRESH_URL: input.contextRefreshUrl } : {}),
```

Add `contextRefreshUrl?: string` to `createRunFromDraft` input and pass it into `materializedWorkflowForExecution`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-validator.test.ts
npm run test:v2 -- tests/v2/agent-runner-cli.test.ts
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/artifacts/downstream-readiness.ts src/v2/artifacts/context-refresh.ts src/v2/agent-runner/cli.ts src/v2/ui-api/local-api.ts tests/v2/artifact-evidence-validator.test.ts tests/v2/agent-runner-cli.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: refresh task context from accepted artifacts"
```

---

## Task 6: Real E2E Goal Prompt and Quantitative Evidence Assertions

**Files:**
- Modify: `tests/e2e-real/scenarios/harness.ts`
- Create: `tests/e2e-real/scenarios/artifact-evidence-validator-real.ts`
- Modify: `tests/e2e-real/index.test.ts`

- [ ] **Step 1: Add real goal prompt and assertions to harness**

In `tests/e2e-real/scenarios/harness.ts`, add this goal prompt:

```ts
export function artifactEvidenceValidatorGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成可驗證的軟工任務：新增 CLI 指令 calc sum <numbers...>。",
    "這不是 smoke test；必須透過真實 Docker/Tork 執行每個 workflow task，並產出可驗收 artifact/evidence/validator resources。",
    "功能要求：支援多個數字、負數、小數；invalid input 必須非 0 exit code 並顯示 Invalid number: <value>。",
    "品質要求：更新單元測試與 README；不新增 runtime dependency；保持最小改動。",
    "Artifact 要求：每個 task 必須產出 contract-valid artifact；implementation artifact 必須包含 summary、filesChanged、commandsRun、testResults、risks、artifactEvidence。",
    "Evidence 要求：每個 accepted artifact 必須有 evidence_packet；implementation 必須有 file-diff、test-result、command-output evidence。",
    "Validator 要求：每個 accepted artifact 必須有 typed validator_result；blocking validator 不可 failed。",
    "Context 要求：downstream task 不可依賴 raw transcript 或盲目掃 workspace；必須使用 accepted upstream artifact/evidence summary。",
    "量化驗收：run 必須 passed/completed；accepted artifact count 必須等於 evidence packet count；blocking validator failures 必須為 0；fixture repo 必須通過 npm test。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}
```

Add this assertion helper:

```ts
export function assertArtifactEvidenceQuantitativeGates(db: SouthstarDb, runId: string): void {
  const completedTasks = count(db, "workflow_tasks", "run_id = ? and status = 'completed'", [runId]);
  assert.equal(completedTasks >= 4, true, `expected at least 4 completed tasks, got ${completedTasks}`);

  const acceptedArtifacts = count(db, "runtime_resources", "run_id = ? and resource_type = 'artifact' and status = 'accepted'", [runId]);
  assert.equal(acceptedArtifacts, completedTasks, `accepted artifact count ${acceptedArtifacts} must equal completed task count ${completedTasks}`);

  const evidencePackets = count(db, "runtime_resources", "run_id = ? and resource_type = 'evidence_packet' and status = 'complete'", [runId]);
  assert.equal(evidencePackets, acceptedArtifacts, `complete evidence packets ${evidencePackets} must equal accepted artifacts ${acceptedArtifacts}`);

  const blockingFailures = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'validator_result'
  `).all(runId) as Array<{ payload_json: string }>;
  const failedBlocking = blockingFailures.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { blocking?: boolean; verdict?: string };
    return payload.blocking === true && payload.verdict === "failed";
  });
  assert.equal(failedBlocking.length, 0, `blocking validator failures must be 0, got ${failedBlocking.length}`);

  const oversized = db.prepare(`
    select resource_type, resource_key, length(payload_json) as size
    from runtime_resources
    where run_id = ? and resource_type in ('artifact', 'evidence_packet', 'validator_result') and length(payload_json) > 50000
  `).all(runId) as Array<{ resource_type: string; resource_key: string; size: number }>;
  assert.deepEqual(oversized, [], `artifact/evidence/validator payloads exceed 50000 bytes: ${JSON.stringify(oversized)}`);

  const readinessRows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'downstream_readiness'
  `).all(runId) as Array<{ payload_json: string }>;
  for (const row of readinessRows) {
    const payload = JSON.parse(row.payload_json) as { ready?: boolean; blockers?: unknown[] };
    assert.equal(payload.ready, true, `downstream readiness must be true: ${row.payload_json}`);
    assert.equal(payload.blockers?.length ?? 0, 0, `downstream readiness blockers must be empty: ${row.payload_json}`);
  }

  const stop = db.prepare(`
    select status from runtime_resources
    where run_id = ? and resource_type = 'stop_condition_result'
    order by created_at desc limit 1
  `).get(runId) as { status: string } | undefined;
  assert.equal(stop?.status, "passed", "terminal stop condition must pass");
}
```

- [ ] **Step 2: Add real E2E scenario**

Create `tests/e2e-real/scenarios/artifact-evidence-validator-real.ts`:

```ts
import assert from "node:assert/strict";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  artifactEvidenceValidatorGoalPrompt,
  assertArtifactEvidenceQuantitativeGates,
  assertCalcSum,
  assertFixtureTests,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export type ArtifactEvidenceValidatorRealResult = {
  runId: string;
  repo: string;
  durationMs: number;
};

export async function runArtifactEvidenceValidatorRealScenario(env: RealE2EEnv): Promise<ArtifactEvidenceValidatorRealResult> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "artifact-evidence-validator-real");
  try {
    const draft = await createPlannerDraft(context.db, {
      goalPrompt: artifactEvidenceValidatorGoalPrompt(repo),
      plannerClient: context.plannerClient,
    });
    const run = await createRunFromDraft(context.db, {
      draftId: draft.draftId,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      contextRefreshUrl: callback.contextRefreshUrl,
      harnessEndpoint: env.piHarnessEndpoint,
    });

    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId, 15 * 60 * 1000);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"], 60_000);

    assertArtifactEvidenceQuantitativeGates(context.db, run.runId);
    assertCalcSum(repo);
    assertFixtureTests(repo);

    const durationMs = Date.now() - startedAt;
    assert.equal(durationMs <= 15 * 60 * 1000, true, `scenario took ${durationMs}ms`);
    console.log("artifact evidence validator real scenario passed");
    return { runId: run.runId, repo, durationMs };
  } finally {
    await callback.close();
  }
}
```

- [ ] **Step 3: Extend callback server with real context refresh endpoint**

Modify `CallbackServer` type in `tests/e2e-real/scenarios/harness.ts`:

```ts
export type CallbackServer = {
  url: string;
  contextRefreshUrl: string;
  close(): Promise<void>;
};
```

Inside `startCallbackServer`, add a route before the 404 branch:

```ts
      if (request.method === "POST" && request.url === "/api/v2/context/refresh") {
        const payload = JSON.parse(await readRequestBody(request)) as { runId: string; taskId: string };
        const workflow = JSON.parse((db.prepare("select workflow_manifest_json from workflow_runs where id = ?").get(payload.runId) as { workflow_manifest_json: string }).workflow_manifest_json) as { tasks: Array<{ id: string; dependsOn: string[] }> };
        const task = workflow.tasks.find((candidate) => candidate.id === payload.taskId);
        const { buildRefreshedContextSummary } = await import("../../../src/v2/artifacts/context-refresh.ts");
        const upstreamContext = buildRefreshedContextSummary(db, {
          runId: payload.runId,
          taskId: payload.taskId,
          dependencyTaskIds: task?.dependsOn ?? [],
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ upstreamContext }));
        return;
      }
```

Return `contextRefreshUrl`:

```ts
  return {
    url: `http://${callbackHost}:${address.port}/api/v2/tork/callback`,
    contextRefreshUrl: `http://${callbackHost}:${address.port}/api/v2/context/refresh`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
```

- [ ] **Step 4: Include scenario in real E2E suite**

Modify `tests/e2e-real/index.test.ts` imports:

```ts
import { runArtifactEvidenceValidatorRealScenario } from "./scenarios/artifact-evidence-validator-real.ts";
```

After the dynamic feature scenario gates, run:

```ts
  await runArtifactEvidenceValidatorRealScenario(env);
```

- [ ] **Step 5: Run TypeScript/unit gate**

Run:

```bash
npm run test:v2
```

Expected: pass.

- [ ] **Step 6: Run real E2E gate with real Docker/Tork**

Run only when real E2E environment is configured:

```bash
npm run test:e2e:real
```

Expected: pass. The new scenario must execute Tork/Docker and print `artifact evidence validator real scenario passed`.

- [ ] **Step 7: Commit**

```bash
git --git-dir=.git-local --work-tree=. add tests/e2e-real/scenarios/harness.ts tests/e2e-real/scenarios/artifact-evidence-validator-real.ts tests/e2e-real/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "test: add real artifact evidence validator e2e"
```

---

## Task 7: Quantitative Gate Module

**Files:**
- Create: `src/v2/quality/artifact-evidence-gates.ts`
- Create: `tests/v2/artifact-evidence-gates.test.ts`
- Modify: `tests/v2/index.test.ts`
- Modify: `tests/e2e-real/index.test.ts`

- [ ] **Step 1: Add failing quantitative gate test**

Create `tests/v2/artifact-evidence-gates.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertArtifactEvidenceGates } from "../../src/v2/quality/artifact-evidence-gates.ts";

test("artifact evidence quantitative gates pass only with complete evidence and no blocking validator failures", () => {
  const db = openSouthstarDb(":memory:");
  seedCompletedTask(db, "run-gate", "task-1");
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-run-gate-task-1",
    runId: "run-gate",
    taskId: "task-1",
    scope: "task",
    status: "accepted",
    title: "Accepted artifact",
    payload: {},
    summary: { contractRef: "implementation_report", evidencePacketRefs: ["evidence-run-gate-task-1"], validatorResultRefs: ["validator-run-gate-task-1"] },
  });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: "evidence-run-gate-task-1",
    runId: "run-gate",
    taskId: "task-1",
    scope: "task",
    status: "complete",
    title: "Evidence",
    payload: { completeness: { requiredCount: 1, presentCount: 1, missingKinds: [] } },
  });
  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: "validator-run-gate-task-1",
    runId: "run-gate",
    taskId: "task-1",
    scope: "task",
    status: "passed",
    title: "Validator",
    payload: { blocking: true, verdict: "passed" },
  });

  const result = assertArtifactEvidenceGates(db, { runId: "run-gate", minCompletedTasks: 1 });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

function seedCompletedTask(db: ReturnType<typeof openSouthstarDb>, runId: string, taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(`insert into workflow_runs (id,status,domain,goal_prompt,executor_job_id,workflow_manifest_json,execution_projection_json,snapshot_json,runtime_context_json,metrics_json,created_at,updated_at,completed_at) values (?, 'passed', 'software', '', null, '{"tasks":[]}', '{}', '{}', '{}', '{}', ?, ?, ?)`).run(runId, now, now, now);
  db.prepare(`insert into workflow_tasks (id, run_id, task_key, status, sort_order, depends_on_json, root_session_id, subagent_session_ids_json, executor_task_id, snapshot_json, metrics_json, created_at, updated_at, completed_at) values (?, ?, ?, 'completed', 0, '[]', null, '[]', null, '{}', '{}', ?, ?, ?)`).run(taskId, runId, taskId, now, now, now);
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./artifact-evidence-gates.test.ts");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-gates.test.ts
```

Expected: fail with missing gate module.

- [ ] **Step 3: Implement gate module**

Create `src/v2/quality/artifact-evidence-gates.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";

export type ArtifactEvidenceGateResult = { ok: boolean; failures: string[] };

export function assertArtifactEvidenceGates(db: SouthstarDb, input: { runId: string; minCompletedTasks: number }): ArtifactEvidenceGateResult {
  const failures: string[] = [];
  const completedTasks = count(db, "workflow_tasks", "run_id = ? and status = 'completed'", [input.runId]);
  if (completedTasks < input.minCompletedTasks) failures.push(`completed task count ${completedTasks} below ${input.minCompletedTasks}`);

  const acceptedArtifacts = count(db, "runtime_resources", "run_id = ? and resource_type = 'artifact' and status = 'accepted'", [input.runId]);
  if (acceptedArtifacts !== completedTasks) failures.push(`accepted artifact count ${acceptedArtifacts} must equal completed task count ${completedTasks}`);

  const completeEvidence = count(db, "runtime_resources", "run_id = ? and resource_type = 'evidence_packet' and status = 'complete'", [input.runId]);
  if (completeEvidence !== acceptedArtifacts) failures.push(`complete evidence packet count ${completeEvidence} must equal accepted artifact count ${acceptedArtifacts}`);

  const validatorRows = db.prepare(`select payload_json from runtime_resources where run_id = ? and resource_type = 'validator_result'`).all(input.runId) as Array<{ payload_json: string }>;
  const blockingFailed = validatorRows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { blocking?: boolean; verdict?: string };
    return payload.blocking === true && payload.verdict === "failed";
  }).length;
  if (blockingFailed !== 0) failures.push(`blocking validator failure count must be 0, got ${blockingFailed}`);

  const incompleteEvidence = db.prepare(`select payload_json from runtime_resources where run_id = ? and resource_type = 'evidence_packet'`).all(input.runId) as Array<{ payload_json: string }>;
  for (const row of incompleteEvidence) {
    const payload = JSON.parse(row.payload_json) as { completeness?: { requiredCount?: number; presentCount?: number; missingKinds?: string[] } };
    const completeness = payload.completeness;
    if (!completeness) failures.push("evidence packet missing completeness");
    else if ((completeness.presentCount ?? 0) < (completeness.requiredCount ?? 0) || (completeness.missingKinds?.length ?? 0) > 0) {
      failures.push(`incomplete evidence packet ${row.payload_json}`);
    }
  }

  const oversized = db.prepare(`select resource_type, resource_key, length(payload_json) as size from runtime_resources where run_id = ? and resource_type in ('artifact', 'evidence_packet', 'validator_result') and length(payload_json) > 50000`).all(input.runId) as Array<{ resource_type: string; resource_key: string; size: number }>;
  if (oversized.length > 0) failures.push(`oversized artifact/evidence/validator payloads: ${JSON.stringify(oversized)}`);

  return { ok: failures.length === 0, failures };
}

type SqlValue = string | number | bigint | Buffer | null;

function count(db: SouthstarDb, table: string, where: string, args: SqlValue[] = []): number {
  const row = db.prepare(`select count(*) as count from ${table} where ${where}`).get(...args) as { count: number };
  return row.count;
}
```

- [ ] **Step 4: Use gate in real E2E suite**

In `tests/e2e-real/index.test.ts`, import:

```ts
import { assertArtifactEvidenceGates } from "../../src/v2/quality/artifact-evidence-gates.ts";
```

After `runArtifactEvidenceValidatorRealScenario(env)`, assign the result and assert:

```ts
  const artifactEvidence = await runArtifactEvidenceValidatorRealScenario(env);
  const artifactEvidenceContext = createScenarioContext(env);
  const artifactGate = assertArtifactEvidenceGates(artifactEvidenceContext.db, {
    runId: artifactEvidence.runId,
    minCompletedTasks: 4,
  });
  assert.equal(artifactGate.ok, true, artifactGate.failures.join("\n"));
```

- [ ] **Step 5: Run gate tests**

Run:

```bash
npm run test:v2 -- tests/v2/artifact-evidence-gates.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/quality/artifact-evidence-gates.ts tests/v2/artifact-evidence-gates.test.ts tests/v2/index.test.ts tests/e2e-real/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: add artifact evidence quantitative gates"
```

---

## Final Verification

- [ ] **Step 1: Run full v2 unit/integration suite**

```bash
npm run test:v2
```

Expected: pass.

- [ ] **Step 2: Run full project test gate**

```bash
npm test
```

Expected: pass.

- [ ] **Step 3: Run real Docker/Tork E2E gate**

Only run when the real E2E environment is explicitly configured and idle:

```bash
npm run test:e2e:real
```

Expected:

- The new real scenario prints `artifact evidence validator real scenario passed`.
- The run reaches `passed` or `completed`.
- `assertArtifactEvidenceGates` passes.
- Real fixture CLI assertions pass.
- Real fixture `npm test` passes inside `southstar/pi-agent:local`.

- [ ] **Step 4: Inspect git state**

```bash
git --git-dir=.git-local --work-tree=. status --short
```

Expected: only intentional committed changes remain; no unrelated user edits are staged.

---

## Plan Self-Review

**Spec coverage:** This plan implements the strengthened artifact/evidence/validator sections of the spec: artifact lifecycle, evidence packets, typed validator results, downstream readiness, refreshed context, real E2E goal prompt, and quantitative gates. It does not implement the full Design Library, full DAG editor, template matching, or auto-run; those are separate platform subsystems and should each get their own implementation plan.

**Placeholder scan:** No placeholder markers or unspecified implementation steps remain. Each task identifies exact files, concrete code, commands, and expected outcomes.

**Type consistency:** `RuntimeArtifactRef`, `EvidencePacket`, `ValidatorResult`, `DownstreamReadiness`, `acceptTaskRunArtifact`, `buildEvidencePacket`, `computeDownstreamReadiness`, `buildRefreshedContextSummary`, and `assertArtifactEvidenceGates` use consistent names across tests and implementation steps.
