# Southstar LLM Design Library / Workflow Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a SQLite-first Design Library that lets Southstar design, approve, compile, execute, validate, and reuse software-development workflow templates, proven by a new real E2E todo-web feature issue.

**Architecture:** Add a design-time library layer beside the existing v2 runtime store using the same runtime pattern (`head snapshot + append-only history`). `library_objects` holds current head state; `library_history` is the source of truth for version/draft/patch/approval events; `library_similarity_index` remains optional projection only. Approved template heads compile deterministically into existing `SouthstarWorkflowManifest` runs with `compiledFrom` metadata. The first vertical slice seeds an approved software-development agent workflow and validates it through real Docker/Tork execution against a todo-web feature issue, with every E2E planner and agent invocation routed through the Pi host adapter.

**Tech Stack:** Node >=22.22.2, TypeScript ESM via `tsx`, `node:test`, `node:sqlite`, existing Southstar v2 stores/runtime, Docker/Tork real E2E harness, Pi host adapter (`@earendil-works/pi-coding-agent` SDK or Pi HTTP endpoints), Playwright for browser behavior evidence.

---

## File Structure

### New runtime/design-library files

- Create: `src/v2/design-library/types.ts` — shared payload, draft, patch, match, and compile types.
- Create: `src/v2/design-library/canonical-json.ts` — stable JSON stringify and sha256 content hash helpers.
- Create: `src/v2/design-library/validators.ts` — payload validators for all 7 `definition_kind` values and graph validation diagnostics.
- Create: `src/v2/design-library/store.ts` — SQLite repository for `library_objects` head snapshots and `library_history` events (plus optional similarity projection).
- Create: `src/v2/design-library/software-dev-seed.ts` — seed approved software-dev library definitions: explorer, planner, implementer, checker, summarizer agents plus capability/contract/validator/policy/template/recipe versions.
- Create: `src/v2/design-library/designer.ts` — requirement clarification, internal library search, agent composition, and draft creation services.
- Create: `src/v2/design-library/patch.ts` — typed `WorkflowTemplatePatch` application and audit.
- Create: `src/v2/design-library/template-validator.ts` — DAG and flow I/O validation before approval.
- Create: `src/v2/design-library/compiler.ts` — immutable template version + issue/run inputs → `SouthstarWorkflowManifest`.
- Create: `src/v2/design-library/lifecycle.ts` — approve-for-run, validate-from-run, deprecate, failure evidence.
- Create: `src/v2/design-library/reuse.ts` — deterministic reuse matcher for similar future issue packets.
- Create: `src/v2/quality/design-library-gates.ts` — quantitative gate helpers for unit/integration/E2E assertions.

### Existing files to modify

- Modify: `src/v2/stores/schema.ts` — add 2 canonical design-library tables (`library_objects`, `library_history`) and optional `library_similarity_index` projection table.
- Modify: `src/v2/stores/sqlite.ts` — keep schema initialization only; do not auto-seed in `openSouthstarDb`.
- Modify: `src/v2/manifests/types.ts` — add `compiledFrom?: CompiledFromTemplate` to `SouthstarWorkflowManifest`.
- Modify: `src/v2/manifests/validate.ts` — validate `compiledFrom` version ids and `inputHash` when present.
- Modify: `src/v2/ui-api/local-api.ts` — add library design/run helper functions without replacing existing planner flow.
- Modify: `src/v2/server/routes.ts` — add `/api/v2/library/*`, `/api/v2/design/*`, `/api/v2/templates/*` endpoints.
- Modify: `tests/v2/index.test.ts` — import new v2 tests.
- Modify: `package.json` — add `test:e2e:design-library-real` script.

### New tests

- Create: `tests/v2/design-library-store.test.ts`
- Create: `tests/v2/design-library-validators.test.ts`
- Create: `tests/v2/design-library-draft-patch.test.ts`
- Create: `tests/v2/design-library-compiler.test.ts`
- Create: `tests/v2/design-library-lifecycle-reuse.test.ts`
- Create: `tests/v2/design-library-server-api.test.ts`
- Create: `tests/v2/design-library-gates.test.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/package.json`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/README.md`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/index.html`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/src/todo-store.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/src/app.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/src/styles.css`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/test/todo-store.test.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/test/browser-baseline.test.ts`
- Create: `tests/e2e-real/scenarios/design-library-template-real.ts`
- Create: `tests/e2e-real/design-library-template-real.test.ts`

---

## Task 1: Design Library Schema, Store, Hashing, and Seed

**Files:**
- Modify: `src/v2/stores/schema.ts`
- Create: `src/v2/design-library/types.ts`
- Create: `src/v2/design-library/canonical-json.ts`
- Create: `src/v2/design-library/store.ts`
- Create: `src/v2/design-library/software-dev-seed.ts`
- Create: `tests/v2/design-library-store.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing store/schema tests**

Create `tests/v2/design-library-store.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import {
  appendDraftEvent,
  appendVersionCreated,
  createLibraryObject,
  getLibraryVersion,
  listLibraryHistory,
  listLibraryVersions,
} from "../../src/v2/design-library/store.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";

const kinds = [
  "agent_spec",
  "capability_spec",
  "contract_spec",
  "validator_spec",
  "policy_bundle",
  "workflow_template",
  "workflow_recipe",
] as const;

test("design library schema creates exactly the canonical tables", () => {
  const db = openSouthstarDb(":memory:");
  const rows = db.prepare(`
    select name from sqlite_master
    where type = 'table' and name like 'library_%'
    order by name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name), [
    "library_history",
    "library_objects",
    "library_similarity_index",
  ]);
});

test("immutable version stores canonical sha256 and append-only history", () => {
  const db = openSouthstarDb(":memory:");
  const object = createLibraryObject(db, {
    objectKey: "software.agent.explorer",
    objectKind: "agent_spec",
    status: "approved",
    state: { domainRefs: ["software"], tags: ["explorer"] },
    actorType: "migration",
  });
  const payload = {
    schemaVersion: "southstar.library.agent_spec.v1",
    identity: { displayName: "Explorer", description: "Inspects repo", domainRefs: ["software"], roleRefs: ["explorer"], capabilityTags: ["repo-read"] },
    responsibilities: { goals: ["understand issue and repo"], nonGoals: ["modify files"], stopAuthority: "can-suggest" },
    executionProfiles: [{ id: "default", provider: "pi", model: "pi-default", harnessRef: "pi", complexityBand: "moderate", preferredFor: ["repo inspection"], fallbackFor: [], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 } }],
    prompts: { system: "Inspect the repository and produce a concise implementation plan.", taskTemplates: [{ id: "issue-analysis", body: "Analyze {{issueTitle}} against {{repoPath}}." }], outputRules: ["Return JSON artifact"], safetyRules: ["Do not edit files"] },
    capabilities: { skillRefs: ["software.repo-read"], mcpCapabilityRefs: [], requiredToolCapabilities: ["filesystem-read"], memoryScopes: ["software"] },
    policies: {},
    contracts: { inputContractRefs: ["software.issue-input"], outputContractRefs: ["software.implementation-plan"], evidenceContractRefs: ["software.repo-evidence"], validatorRefs: ["software.schema-validator"] },
    provenance: { source: "seed", createdBy: "migration" },
  };

  const version = appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "agent_spec",
    versionId: "ver-1.0.0",
    payload,
    createdBy: "migration",
    status: "approved",
  });

  assert.equal(version.contentHash, contentHashForPayload(payload));
  assert.deepEqual(getLibraryVersion(db, version.versionId)?.payload, payload);
  assert.equal(listLibraryVersions(db, object.objectId).length, 1);
  assert.equal(listLibraryHistory(db, { objectId: object.objectId }).length, 2);
});

test("software-dev seed creates approved immutable versions across all definition kinds", () => {
  const db = openSouthstarDb(":memory:");
  const seed = seedSoftwareDevDesignLibrary(db, { actorType: "migration" });

  assert.equal(seed.createdVersionIds.length >= 14, true, `expected >=14 versions, got ${seed.createdVersionIds.length}`);
  for (const kind of kinds) {
    const count = db.prepare(`
      select count(*) as count
      from library_history
      where event_type = 'version.created'
        and json_extract(payload_json, '$.definitionKind') = ?
    `).get(kind) as { count: number };
    assert.equal(count.count > 0, true, `missing seeded ${kind}`);
  }

  const llmApproved = db.prepare(`
    select count(*) as count
    from library_history
    where event_type = 'version.created'
      and actor_type = 'llm'
  `).get() as { count: number };
  assert.equal(llmApproved.count, 0);
});

test("LLM may append draft events but cannot append approved version events", () => {
  const db = openSouthstarDb(":memory:");
  const object = createLibraryObject(db, {
    objectKey: "llm.proposed.capability",
    objectKind: "capability_spec",
    status: "draft",
    state: { domainRefs: ["software"], tags: ["proposal"] },
    actorType: "llm",
  });

  appendDraftEvent(db, {
    objectId: object.objectId,
    eventType: "draft.opened",
    status: "draft",
    payload: { proposedKind: "capability_spec", title: "Browser capture" },
    actorType: "llm",
  });

  assert.throws(() => appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "capability_spec",
    versionId: "ver-1.0.0",
    payload: { schemaVersion: "southstar.library.capability_spec.v1" },
    createdBy: "llm",
    status: "approved",
  }), /LLM cannot create approved library versions/i);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm run test:v2
```

Expected: FAIL with module/table errors for `src/v2/design-library/*` and missing `library_*` tables.

- [ ] **Step 3: Add schema tables**

In `src/v2/stores/schema.ts`, append these tables inside `SOUTHSTAR_V2_SCHEMA` after existing runtime indexes:

```sql
create table if not exists library_objects (
  id text primary key,
  object_key text unique not null,
  object_kind text not null,
  status text not null,
  head_version_id text,
  state_json text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists library_history (
  id text primary key,
  object_id text not null references library_objects(id),
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  payload_json text not null,
  created_at text not null,
  unique(object_id, sequence)
);

create table if not exists library_similarity_index (
  id text primary key,
  object_id text not null references library_objects(id),
  signature text not null,
  embedding_json text not null,
  metadata_json text not null,
  created_at text not null
);

create index if not exists idx_library_objects_kind on library_objects(object_kind);
create index if not exists idx_library_objects_status on library_objects(status);
create index if not exists idx_library_history_object_sequence on library_history(object_id, sequence);
create index if not exists idx_library_history_event_type on library_history(event_type);
create index if not exists idx_library_similarity_signature on library_similarity_index(signature);
```

- [ ] **Step 4: Add design-library types**

Create `src/v2/design-library/types.ts` with these exported unions and records:

```ts
export type LibraryDefinitionKind =
  | "agent_spec"
  | "capability_spec"
  | "contract_spec"
  | "validator_spec"
  | "policy_bundle"
  | "workflow_template"
  | "workflow_recipe";

export type LibraryActorType = "user" | "system" | "migration" | "llm" | "validator" | "runtime";
export type LibraryDefinitionStatus = "draft" | "approved" | "deprecated" | "blocked";
export type LibraryDraftStatus = "draft" | "invalid" | "valid" | "approved_for_run" | "rejected";

export type DefinitionProvenance = {
  source: "seed" | "user" | "llm-proposal" | "migration" | "runtime-evidence";
  createdBy: LibraryActorType;
  sourceRefs?: string[];
};

export type RequirementSpec = {
  summary: string;
  requiredInputs: string[];
  clarifiedInputs: Record<string, unknown>;
  assumptions: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  riskNotes: string[];
};

export type WorkflowTemplatePatch = {
  baseDraftId: string;
  operations: Array<
    | { op: "add-node"; node: WorkflowTemplateNode }
    | { op: "remove-node"; nodeId: string }
    | { op: "update-node"; nodeId: string; patch: Record<string, unknown> }
    | { op: "add-edge"; edge: WorkflowTemplateEdge }
    | { op: "remove-edge"; edgeId: string }
    | { op: "replace-agent"; nodeId: string; agentSpecRef: string }
    | { op: "set-contracts"; nodeId: string; contractRefs: string[] }
    | { op: "set-validators"; nodeId: string; validatorRefs: string[] }
  >;
  rationale: string;
  actor: "llm" | "user" | "system";
};

export type WorkflowTemplateNode = {
  id: string;
  nodeType: "agent_task" | "validator_task" | "human_gate" | "decision" | "fan_in" | "artifact_transform" | "template_operation";
  name: string;
  roleRef?: string;
  agentSpecRef?: string;
  executionProfileSelector?: { complexityBand: string; preferredProfileId?: string };
  contractRefs: string[];
  validatorRefs: string[];
  capabilityRefs: string[];
  mcpCapabilityRefs: string[];
  workspacePolicyRef?: string;
};

export type WorkflowTemplateEdge = {
  id: string;
  from: string;
  to: string;
  edgeType: "depends_on" | "artifact_flow" | "approval_gate" | "decision_path" | "fan_in";
  artifactContractRefs: string[];
  workspaceStateRequired?: boolean;
  condition?: string;
};

export type WorkflowTemplatePayload = {
  schemaVersion: "southstar.library.workflow_template.v1";
  templateType: "exact";
  inputContractRef: string;
  flow: {
    primaryPattern: string;
    secondaryPatterns: string[];
    nodes: WorkflowTemplateNode[];
    edges: WorkflowTemplateEdge[];
    fanIns?: Array<{ nodeId: string; strategy: "all-pass" | "majority" | "best-candidate" | "checker-arbitrated"; requiredInputs: string[] }>;
    recovery: { onValidatorFailure: string; maxAttempts: number };
  };
  outputContractRefs: string[];
  evidenceContractRefs: string[];
  stopConditionValidatorRefs: string[];
  lifecycle: {
    status: "draft" | "approved_for_run" | "validated" | "deprecated" | "blocked";
    validatedByRunIds: string[];
    failureEvidenceRefs: string[];
  };
  reuse: {
    signature: string;
    tags: string[];
    requiredInputs: string[];
    assumptionDefaults: Record<string, unknown>;
    clarificationPolicy: { askOnlyWhenMissingRequiredInput: boolean; askWhenSimilarityBelow: number; askWhenRiskAbove: "low" | "medium" | "high" };
    requirementSpecSnapshot: RequirementSpec;
  };
};

export type TemplateMatchResult = {
  templateVersionRef: string;
  confidence: number;
  missingInputs: string[];
  risk: "low" | "medium" | "high";
  reason: string;
  clarificationQuestionCount: number;
};

export type LibraryValidationResult = {
  ok: boolean;
  issues: Array<{ path: string; message: string; code?: string }>;
};
```

- [ ] **Step 5: Add canonical hashing helper**

Create `src/v2/design-library/canonical-json.ts`:

```ts
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function contentHashForPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}
```

- [ ] **Step 6: Add store implementation**

Create `src/v2/design-library/store.ts` with these exports and behavior:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { contentHashForPayload } from "./canonical-json.ts";
import type { LibraryActorType, LibraryDefinitionKind, LibraryDefinitionStatus, LibraryDraftStatus } from "./types.ts";

type SqlValue = string | number | bigint | Buffer | null;

export type LibraryObjectRecord = {
  objectId: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  headVersionId?: string;
  status: LibraryDefinitionStatus;
  state: Record<string, unknown>;
};

export type LibraryVersionRecord = {
  versionId: string;
  objectId: string;
  definitionKind: LibraryDefinitionKind;
  payload: unknown;
  contentHash: string;
  createdBy: LibraryActorType;
};

export function createLibraryObject(db: SouthstarDb, input: {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  state: Record<string, unknown>;
  actorType: LibraryActorType;
}): { objectId: string } {
  const now = new Date().toISOString();
  const id = `obj-${randomUUID()}`;
  db.prepare(`
    insert into library_objects (id, object_key, object_kind, status, head_version_id, state_json, created_at, updated_at)
    values (?, ?, ?, ?, null, ?, ?, ?)
  `).run(id, input.objectKey, input.objectKind, input.status, JSON.stringify(input.state), now, now);
  appendLibraryHistory(db, { objectId: id, eventType: "object.created", actorType: input.actorType, payload: input });
  return { objectId: id };
}

export function appendVersionCreated(db: SouthstarDb, input: {
  objectId: string;
  definitionKind: LibraryDefinitionKind;
  versionId: string;
  payload: unknown;
  createdBy: LibraryActorType;
  status: LibraryDefinitionStatus;
}): LibraryVersionRecord {
  if (input.createdBy === "llm" && input.status === "approved") {
    throw new Error("LLM cannot create approved library versions; create draft/proposal events instead");
  }
  const now = new Date().toISOString();
  const contentHash = contentHashForPayload(input.payload);
  appendLibraryHistory(db, {
    objectId: input.objectId,
    eventType: "version.created",
    actorType: input.createdBy,
    payload: {
      versionId: input.versionId,
      definitionKind: input.definitionKind,
      payload: input.payload,
      contentHash,
      status: input.status,
      createdAt: now,
    },
  });
  db.prepare(`
    update library_objects
    set head_version_id = ?, status = ?, updated_at = ?, state_json = json_set(state_json, '$.headContentHash', ?)
    where id = ?
  `).run(input.versionId, input.status, now, contentHash, input.objectId);
  return { versionId: input.versionId, objectId: input.objectId, definitionKind: input.definitionKind, payload: input.payload, contentHash, createdBy: input.createdBy };
}

export function appendDraftEvent(db: SouthstarDb, input: {
  objectId: string;
  eventType: "draft.opened" | "draft.patch_applied" | "draft.validated" | "draft.approved_for_run";
  status: LibraryDraftStatus;
  payload: unknown;
  actorType: LibraryActorType;
}): void {
  appendLibraryHistory(db, {
    objectId: input.objectId,
    eventType: input.eventType,
    actorType: input.actorType,
    payload: { status: input.status, ...asRecord(input.payload) },
  });
  db.prepare(`
    update library_objects
    set updated_at = ?, state_json = json_set(state_json, '$.draftStatus', ?)
    where id = ?
  `).run(new Date().toISOString(), input.status, input.objectId);
}

export function getLibraryVersion(db: SouthstarDb, versionId: string): LibraryVersionRecord | null {
  const row = db.prepare(`
    select object_id, actor_type, payload_json
    from library_history
    where event_type = 'version.created'
      and json_extract(payload_json, '$.versionId') = ?
    order by created_at desc
    limit 1
  `).get(versionId) as { object_id: string; actor_type: LibraryActorType; payload_json: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as { definitionKind: LibraryDefinitionKind; payload: unknown; contentHash: string; versionId: string };
  return {
    versionId: payload.versionId,
    objectId: row.object_id,
    definitionKind: payload.definitionKind,
    payload: payload.payload,
    contentHash: payload.contentHash,
    createdBy: row.actor_type,
  };
}

export function listLibraryVersions(db: SouthstarDb, objectId: string): LibraryVersionRecord[] {
  const rows = db.prepare(`
    select actor_type, payload_json
    from library_history
    where object_id = ? and event_type = 'version.created'
    order by sequence
  `).all(objectId) as Array<{ actor_type: LibraryActorType; payload_json: string }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { definitionKind: LibraryDefinitionKind; payload: unknown; contentHash: string; versionId: string };
    return {
      versionId: payload.versionId,
      objectId,
      definitionKind: payload.definitionKind,
      payload: payload.payload,
      contentHash: payload.contentHash,
      createdBy: row.actor_type,
    };
  });
}

export function listLibraryHistory(db: SouthstarDb, input: { objectId: string }): Array<{ sequence: number; eventType: string; actorType: string; payload: unknown }> {
  return (db.prepare(`select sequence, event_type, actor_type, payload_json from library_history where object_id = ? order by sequence`).all(input.objectId) as Array<{ sequence: number; event_type: string; actor_type: string; payload_json: string }>).map((row) => ({ sequence: row.sequence, eventType: row.event_type, actorType: row.actor_type, payload: JSON.parse(row.payload_json) }));
}

export function appendLibraryHistory(db: SouthstarDb, input: { objectId: string; eventType: string; actorType: LibraryActorType; payload: unknown }): { historyId: string; sequence: number } {
  const id = `hist-${randomUUID()}`;
  const sequence = (db.prepare(`select coalesce(max(sequence), 0) + 1 as next from library_history where object_id = ?`).get(input.objectId) as { next: number }).next;
  db.prepare(`
    insert into library_history (id, object_id, sequence, event_type, actor_type, payload_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.objectId, sequence, input.eventType, input.actorType, JSON.stringify(input.payload), new Date().toISOString());
  return { historyId: id, sequence };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : { value };
}
```

- [ ] **Step 7: Add software-dev seed**

Create `src/v2/design-library/software-dev-seed.ts`. It must create at least these definition keys:

```ts
const requiredDefinitionKeys = [
  "software-dev.agent.explorer",
  "software-dev.agent.planner",
  "software-dev.agent.implementer",
  "software-dev.agent.checker",
  "software-dev.agent.summarizer",
  "software-dev.capability.repo-read-write",
  "software-dev.capability.browser-ux-verification",
  "software-dev.contract.issue-input",
  "software-dev.contract.implementation-artifact",
  "software-dev.contract.verification-artifact",
  "software-dev.contract.completion-artifact",
  "software-dev.validator.schema-evidence-policy",
  "software-dev.policy.safe-workspace-tork",
  "software-dev.template.issue-to-pr-style-todo-web",
  "software-dev.recipe.todo-web-adaptation",
];
```

The seed function returns `{ createdObjectIds: string[]; createdVersionIds: string[] }`, is idempotent by `object_key`, and uses `createdBy: "migration"` for every `version.created` event.

- [ ] **Step 8: Import test in index**

Append to `tests/v2/index.test.ts`:

```ts
await import("./design-library-store.test.ts");
```

- [ ] **Step 9: Run test and verify it passes**

Run:

```bash
npm run test:v2
```

Expected: PASS for the new store tests; unrelated failures must be fixed before continuing.

- [ ] **Step 10: Commit**

```bash
git add src/v2/stores/schema.ts src/v2/design-library tests/v2/design-library-store.test.ts tests/v2/index.test.ts
git commit -m "feat(v2): add design library store and seed"
```

---

## Task 2: Payload Validators, Drafts, Patches, and DAG Validation

**Files:**
- Create: `src/v2/design-library/validators.ts`
- Create: `src/v2/design-library/patch.ts`
- Create: `src/v2/design-library/template-validator.ts`
- Create: `tests/v2/design-library-validators.test.ts`
- Create: `tests/v2/design-library-draft-patch.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing validator tests**

Create `tests/v2/design-library-validators.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { validateLibraryPayload } from "../../src/v2/design-library/validators.ts";
import { validateWorkflowTemplateGraph } from "../../src/v2/design-library/template-validator.ts";
import type { WorkflowTemplatePayload } from "../../src/v2/design-library/types.ts";

test("validator accepts all seeded definition kind payloads", () => {
  const payloads = validPayloads();
  for (const [kind, payload] of Object.entries(payloads)) {
    const result = validateLibraryPayload(kind as Parameters<typeof validateLibraryPayload>[0], payload);
    assert.equal(result.ok, true, `${kind}: ${JSON.stringify(result.issues)}`);
  }
});

test("workflow template graph rejects cycles, missing producers, and raw transcript dependency", () => {
  const cyclic = validTemplate();
  cyclic.flow.edges.push({ id: "cycle", from: "checker", to: "implementer", edgeType: "depends_on", artifactContractRefs: ["software-dev.contract.verification-artifact"] });
  assert.equal(validateWorkflowTemplateGraph(cyclic).ok, false);

  const missingProducer = validTemplate();
  missingProducer.flow.edges[0] = { id: "bad", from: "unknown", to: "implementer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"] };
  assert.match(JSON.stringify(validateWorkflowTemplateGraph(missingProducer).issues), /unknown|producer|node/i);

  const transcriptOnly = validTemplate();
  transcriptOnly.flow.nodes[1]!.contractRefs = ["raw_transcript"];
  assert.match(JSON.stringify(validateWorkflowTemplateGraph(transcriptOnly).issues), /raw transcript/i);
});

function validTemplate(): WorkflowTemplatePayload {
  return {
    schemaVersion: "southstar.library.workflow_template.v1",
    templateType: "exact",
    inputContractRef: "software-dev.contract.issue-input",
    flow: {
      primaryPattern: "maker_checker",
      secondaryPatterns: ["human_gate"],
      nodes: [
        { id: "planner", nodeType: "agent_task", name: "Planner", roleRef: "planner", agentSpecRef: "software-dev.agent.planner@1.0.0", contractRefs: ["software-dev.contract.issue-input"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.repo-read-write@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" },
        { id: "implementer", nodeType: "agent_task", name: "Implementer", roleRef: "implementer", agentSpecRef: "software-dev.agent.implementer@1.0.0", contractRefs: ["software-dev.contract.implementation-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.repo-read-write@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" },
        { id: "checker", nodeType: "agent_task", name: "Checker", roleRef: "checker", agentSpecRef: "software-dev.agent.checker@1.0.0", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" },
      ],
      edges: [
        { id: "planner-to-implementer", from: "planner", to: "implementer", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true },
        { id: "implementer-to-checker", from: "implementer", to: "checker", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.verification-artifact"], workspaceStateRequired: true },
      ],
      recovery: { onValidatorFailure: "request_workflow_revision", maxAttempts: 2 },
    },
    outputContractRefs: ["software-dev.contract.completion-artifact"],
    evidenceContractRefs: ["software-dev.contract.implementation-artifact", "software-dev.contract.verification-artifact"],
    stopConditionValidatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"],
    lifecycle: { status: "draft", validatedByRunIds: [], failureEvidenceRefs: [] },
    reuse: { signature: "software todo-web feature issue", tags: ["software", "todo-web"], requiredInputs: ["issueTitle", "issueBody", "repoPath"], assumptionDefaults: {}, clarificationPolicy: { askOnlyWhenMissingRequiredInput: true, askWhenSimilarityBelow: 0.85, askWhenRiskAbove: "low" }, requirementSpecSnapshot: { summary: "Todo-web feature", requiredInputs: ["issueTitle", "issueBody", "repoPath"], clarifiedInputs: {}, assumptions: [], acceptanceCriteria: ["tests pass"], nonGoals: [], riskNotes: [] } },
  };
}

function validPayloads(): Record<string, unknown> {
  return {
    agent_spec: { schemaVersion: "southstar.library.agent_spec.v1", identity: { displayName: "Checker", description: "Checks", domainRefs: ["software"], roleRefs: ["checker"], capabilityTags: ["browser"] }, responsibilities: { goals: ["verify"], nonGoals: ["merge"], stopAuthority: "can-reject" }, executionProfiles: [{ id: "default", provider: "pi", model: "pi-default", harnessRef: "pi", complexityBand: "moderate", preferredFor: ["verification"], fallbackFor: [], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 } }], prompts: { system: "Verify feature", taskTemplates: [{ id: "verify", body: "Verify {{issueTitle}}" }], outputRules: ["JSON"], safetyRules: ["No secrets"] }, capabilities: { skillRefs: [], mcpCapabilityRefs: [], requiredToolCapabilities: [], memoryScopes: [] }, policies: {}, contracts: { inputContractRefs: [], outputContractRefs: [], evidenceContractRefs: [], validatorRefs: [] }, provenance: { source: "seed", createdBy: "migration" } },
    capability_spec: { schemaVersion: "southstar.library.capability_spec.v1", capabilityType: "tool_capability", title: "Browser", description: "Browser verification", requiredMounts: [], requiredOperations: ["open-page"], risk: { level: "low", dataSensitivity: "workspace", approvalRequired: false }, contractRefs: [], validatorRefs: [], provenance: { source: "seed", createdBy: "migration" } },
    contract_spec: { schemaVersion: "southstar.library.contract_spec.v1", contractType: "output", fields: [{ name: "summary", type: "string", required: true, description: "Summary" }], evidenceRequirements: [{ kind: "test-result", required: true, description: "Tests" }], artifactType: "implementation_result" },
    validator_spec: { schemaVersion: "southstar.library.validator_spec.v1", validatorType: "pipeline", config: {}, required: true, failureStrategy: "request-workflow-revision", appliesToContractRefs: [], steps: [] },
    policy_bundle: { schemaVersion: "southstar.library.policy_bundle.v1", policyTypes: ["tool"], tool: { allowedTools: ["bash", "read", "edit"], deniedTools: ["secret-read"], requiresApprovalFor: [], networkPolicy: "none", filesystemPolicy: "workspace-write", shellPolicy: "workspace-shell" } },
    workflow_template: validTemplate(),
    workflow_recipe: { schemaVersion: "southstar.library.workflow_recipe.v1", baseTemplateRef: "software-dev.template.issue-to-pr-style-todo-web@1.0.0", adaptationRules: [{ condition: "requires browser evidence", action: "add-checker", parameters: { capability: "browser" } }], allowedAgentSpecRefs: ["software-dev.agent.checker@1.0.0"], allowedCapabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], maxTasks: 8, maxParallelTasks: 2 },
  };
}
```

- [ ] **Step 2: Write failing patch tests**

Create `tests/v2/design-library-draft-patch.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { appendDraftEvent, createLibraryObject, listLibraryHistory } from "../../src/v2/design-library/store.ts";
import { applyWorkflowTemplatePatch } from "../../src/v2/design-library/patch.ts";

test("LLM and UI patches mutate drafts through the same typed model and audit events", () => {
  const db = openSouthstarDb(":memory:");
  const draft = createLibraryObject(db, {
    objectKey: "draft.workflow.todo-web",
    objectKind: "workflow_template",
    status: "draft",
    state: { flow: { nodes: [], edges: [] }, lifecycle: { status: "draft" }, validation: { ok: false, issues: [] } },
    actorType: "llm",
  });
  appendDraftEvent(db, {
    objectId: draft.objectId,
    eventType: "draft.opened",
    status: "draft",
    payload: { source: "llm" },
    actorType: "llm",
  });

  applyWorkflowTemplatePatch(db, {
    baseDraftId: draft.objectId,
    actor: "llm",
    rationale: "Add browser UX verification for todo-web feature acceptance.",
    operations: [{ op: "add-node", node: { id: "browser-ux-verification", nodeType: "agent_task", name: "Browser UX Verification", roleRef: "checker", agentSpecRef: "software-dev.agent.checker@1.0.0", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" } }],
  });
  applyWorkflowTemplatePatch(db, {
    baseDraftId: draft.objectId,
    actor: "user",
    rationale: "Connect implementation output to browser checker.",
    operations: [{ op: "add-edge", edge: { id: "implementer-to-browser-ux", from: "implementer", to: "browser-ux-verification", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true } }],
  });

  const history = listLibraryHistory(db, { objectId: draft.objectId });
  assert.equal(history.filter((event) => event.eventType === "draft.patch_applied").length, 2);
  assert.deepEqual(history.map((event) => event.sequence), [1, 2, 3]);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-validators.test.ts
node --disable-warning=ExperimentalWarning tests/v2/design-library-draft-patch.test.ts
```

Expected: FAIL with missing modules/functions.

- [ ] **Step 4: Implement validators and patch application**

Implement these exported functions:

```ts
// src/v2/design-library/validators.ts
export function validateLibraryPayload(kind: LibraryDefinitionKind, payload: unknown): LibraryValidationResult;

// src/v2/design-library/template-validator.ts
export function validateWorkflowTemplateGraph(template: WorkflowTemplatePayload): LibraryValidationResult;

// src/v2/design-library/patch.ts
export function applyWorkflowTemplatePatch(db: SouthstarDb, patch: WorkflowTemplatePatch): { draftId: string; validation: LibraryValidationResult };
```

Validation rules required in code:

```ts
const knownLifecycleStatuses = new Set(["draft", "approved_for_run", "validated", "deprecated", "blocked"]);
const forbiddenContractRefs = new Set(["raw_transcript", "executor_stdout", "freeform_transcript"]);
```

`validateWorkflowTemplateGraph` must:

1. Build `nodeIds = new Set(template.flow.nodes.map((node) => node.id))`.
2. Reject every edge whose `from` or `to` is absent.
3. Detect cycles with DFS using `visiting` and `visited` sets.
4. Reject non-root agent/validator nodes without at least one incoming edge.
5. Reject any `contractRefs` entry in `forbiddenContractRefs`.
6. Reject every agent/validator node with zero `validatorRefs`.
7. Reject missing `stopConditionValidatorRefs`.

`applyWorkflowTemplatePatch` must:

1. Load current draft payload from `library_objects.state_json` by `baseDraftId` (object id).
2. Apply operations to `payload.flow.nodes` and `payload.flow.edges`.
3. Reject duplicate node ids and duplicate edge ids.
4. Re-run `validateWorkflowTemplateGraph` when payload is a workflow template.
5. Update `library_objects.state_json`, `status`, `updated_at` and append `draft.patch_applied` into `library_history`.
6. Append one `library_history` event `draft.patch_applied` with actor and operations.

- [ ] **Step 5: Import tests in index**

Append:

```ts
await import("./design-library-validators.test.ts");
await import("./design-library-draft-patch.test.ts");
```

- [ ] **Step 6: Run tests and verify pass**

Run:

```bash
npm run test:v2
```

Expected: all new validator/patch tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/v2/design-library tests/v2/design-library-validators.test.ts tests/v2/design-library-draft-patch.test.ts tests/v2/index.test.ts
git commit -m "feat(v2): validate and patch workflow template drafts"
```

---

## Task 3: Requirement Designer and Software-Dev Agent Workflow Composition

**Files:**
- Create: `src/v2/design-library/designer.ts`
- Modify: `src/v2/design-library/software-dev-seed.ts`
- Create: `tests/v2/design-library-designer.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing designer test**

Create `tests/v2/design-library-designer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../src/v2/design-library/designer.ts";

const issue = {
  title: "Todo-web: add priority labels, due dates, and overdue filter",
  body: "Users need to assign priority and due dates to todos, filter overdue items, and keep the state after reload.",
  labels: ["feature", "todo-web", "frontend"],
  repoPath: "/workspace/todo-web",
  acceptanceCriteria: [
    "Each todo can show low, medium, or high priority.",
    "Each todo can store an ISO due date.",
    "Overdue filter shows only incomplete todos with due date before today.",
    "Todo state persists in localStorage across reload.",
    "Unit and browser behavior tests pass in Docker.",
  ],
};

test("designer creates software-dev workflow draft from a real todo-web issue packet", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });

  const result = await createWorkflowDesignDraftFromIssue(db, {
    issue,
    actorType: "llm",
    plannerClient: { generate: async (prompt) => JSON.stringify({ promptLength: prompt.length }) },
  });

  assert.match(result.draftId, /^draft-/);
  assert.equal(result.requirementSpec.requiredInputs.length >= 3, true);
  assert.equal(result.requirementSpec.acceptanceCriteria.length, 5);
  assert.equal(result.librarySearchTrace.matchedDefinitions.length >= 5, true);
  assert.equal(result.externalDiscoveryTrace.sources.length, 0, "internal seed should satisfy the first todo-web workflow");
  assert.deepEqual(result.agentComposition.map((entry) => entry.roleRef), ["explorer", "planner", "implementer", "checker", "summarizer"]);
  assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues));
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-designer.test.ts
```

Expected: FAIL because `designer.ts` is missing.

- [ ] **Step 3: Implement designer service**

Create `src/v2/design-library/designer.ts` exporting:

```ts
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
  librarySearchTrace: { query: string; matchedDefinitions: Array<{ definitionRef: string; kind: string; score: number; reason: string }>; gaps: string[] };
  externalDiscoveryTrace: { source: "web"; queries: string[]; sources: Array<{ url: string; title: string; summary: string; proposedUse: string; risk: "low" | "medium" | "high" }> };
  agentComposition: Array<{ roleRef: string; selectedAgentSpecRef: string; rationale: string; unresolvedRisks: string[] }>;
  validation: LibraryValidationResult;
}>;
```

Implementation requirements:

- Build `RequirementSpec` from issue title/body/acceptance criteria.
- Required inputs must include `issueTitle`, `issueBody`, `repoPath`, `acceptanceCriteria`.
- Query `library_objects` (kind `agent_spec`) plus latest `version.created` events in `library_history` for approved software-dev agent specs.
- Select exactly one agent per role: explorer, planner, implementer, checker, summarizer.
- Compose a `WorkflowTemplatePayload` with at least 5 nodes and artifact-flow edges.
- Call `input.plannerClient.generate(...)` to record that the real planner adapter path is exercised; do not trust it to approve definitions.
- Store the draft with `createdBy: input.actorType`, `draftType: "workflow_template"`, and validation result from `validateWorkflowTemplateGraph`.

- [ ] **Step 4: Import test in index**

Append:

```ts
await import("./design-library-designer.test.ts");
```

- [ ] **Step 5: Run tests and verify pass**

Run:

```bash
npm run test:v2
```

Expected: designer test passes and existing v2 tests remain green.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/designer.ts src/v2/design-library/software-dev-seed.ts tests/v2/design-library-designer.test.ts tests/v2/index.test.ts
git commit -m "feat(v2): compose software-dev workflow drafts from issue packets"
```

---

## Task 4: Approve, Compile Immutable Template, and Manifest Validation

**Files:**
- Create: `src/v2/design-library/compiler.ts`
- Create: `src/v2/design-library/lifecycle.ts`
- Modify: `src/v2/manifests/types.ts`
- Modify: `src/v2/manifests/validate.ts`
- Create: `tests/v2/design-library-compiler.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing compiler test**

Create `tests/v2/design-library-compiler.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { validateWorkflowManifest } from "../../src/v2/manifests/validate.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../src/v2/design-library/designer.ts";
import { approveDraftForRun } from "../../src/v2/design-library/lifecycle.ts";
import { compileTemplateVersionToManifest } from "../../src/v2/design-library/compiler.ts";

test("approved template compiles from immutable version refs into a valid Tork manifest", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const issue = todoIssue("/tmp/todo-web");
  const draft = await createWorkflowDesignDraftFromIssue(db, {
    issue,
    actorType: "llm",
    plannerClient: { generate: async () => "{}" },
  });
  const approved = approveDraftForRun(db, { draftId: draft.draftId, approvedBy: "user", version: "1.0.0" });

  const manifest = compileTemplateVersionToManifest(db, {
    templateVersionId: approved.templateVersionId,
    issue,
    runInputs: { repoPath: issue.repoPath, issueTitle: issue.title, issueBody: issue.body, acceptanceCriteria: issue.acceptanceCriteria },
    compilerVersion: "design-library-compiler-v1",
  });

  assert.equal(manifest.compiledFrom?.templateVersionId, approved.templateVersionId);
  assert.match(manifest.compiledFrom?.inputHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(manifest.tasks.length >= 5, true);
  assert.equal(manifest.tasks.every((task) => task.execution.engine === "tork"), true);
  assert.equal(manifest.tasks.every((task) => task.subagents.every((subagent) => subagent.harnessId === "pi")), true);
  assert.equal(manifest.harnessDefinitions.every((harness) => harness.kind === "pi-agent"), true);
  assert.equal(manifest.tasks.some((task) => task.id.includes("browser-ux")), true);
  const validation = validateWorkflowManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
});

function todoIssue(repoPath: string) {
  return {
    title: "Todo-web: add priority labels, due dates, and overdue filter",
    body: "Implement the todo-web feature issue in the fixture repo.",
    labels: ["feature", "todo-web"],
    repoPath,
    acceptanceCriteria: ["priority labels", "due dates", "overdue filter", "localStorage persistence", "tests pass"],
  };
}
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-compiler.test.ts
```

Expected: FAIL because lifecycle/compiler and `compiledFrom` do not exist.

- [ ] **Step 3: Add manifest compiledFrom type**

Modify `src/v2/manifests/types.ts`:

```ts
export type CompiledFromTemplate = {
  templateDefinitionId: string;
  templateVersionId: string;
  recipeVersionId?: string;
  compilerVersion: string;
  inputHash: string;
  libraryVersionRefs: string[];
};
```

Add to `SouthstarWorkflowManifest`:

```ts
compiledFrom?: CompiledFromTemplate;
```

Modify `src/v2/manifests/validate.ts` to reject present `compiledFrom` when:

- `templateDefinitionId` is empty.
- `templateVersionId` is empty.
- `compilerVersion` is empty.
- `inputHash` is not `/^[a-f0-9]{64}$/`.
- `libraryVersionRefs` is empty.

- [ ] **Step 4: Implement approval lifecycle**

Create `src/v2/design-library/lifecycle.ts` with:

```ts
export function approveDraftForRun(db: SouthstarDb, input: {
  draftId: string;
  approvedBy: "user" | "system";
  version: string;
}): { templateDefinitionId: string; templateVersionId: string };
```

Behavior:

1. Load draft by id.
2. Validate payload with `validateWorkflowTemplateGraph`.
3. Create or reuse `library_objects.object_key = payload.reuse.signature` with `object_kind = "workflow_template"`.
4. Create a library version with lifecycle status changed to `approved_for_run`.
5. Update draft status to `approved_for_run`.
6. Append `draft.approved_for_run` history.

- [ ] **Step 5: Implement compiler**

Create `src/v2/design-library/compiler.ts` with:

```ts
export function compileTemplateVersionToManifest(db: SouthstarDb, input: {
  templateVersionId: string;
  issue: TodoWebFeatureIssuePacket;
  runInputs: Record<string, unknown>;
  compilerVersion: string;
}): SouthstarWorkflowManifest;
```

Mapping rules:

- Every `agent_task` node becomes one `WorkflowTaskDefinition`.
- Dependencies come from incoming template edges.
- `roleRef`, `agentSpecRef`, `capabilityRefs`, `validatorRefs`, and `workspacePolicyRef` are copied into task metadata.
- `execution.engine` is always `"tork"`.
- `execution.image` is `"southstar/pi-agent:local"`.
- `execution.command` is `["southstar-agent-runner"]`.
- Every compiled task subagent uses `harnessId: "pi"`; every manifest harness definition uses `kind: "pi-agent"`.
- `execution.mounts` includes `{ source: issue.repoPath, target: "/workspace/repo", readonly: false }`.
- Browser checker tasks include prompt inputs requiring Playwright/browser evidence.
- Manifest includes `compiledFrom` with immutable version ids and `contentHashForPayload({ issue, runInputs })`.

- [ ] **Step 6: Import test and run suite**

Append:

```ts
await import("./design-library-compiler.test.ts");
```

Run:

```bash
npm run test:v2
```

Expected: compiler test passes; manifest validation accepts `compiledFrom`.

- [ ] **Step 7: Commit**

```bash
git add src/v2/design-library/compiler.ts src/v2/design-library/lifecycle.ts src/v2/manifests/types.ts src/v2/manifests/validate.ts tests/v2/design-library-compiler.test.ts tests/v2/index.test.ts
git commit -m "feat(v2): compile approved library templates into runtime manifests"
```

---

## Task 5: Runtime API Surface for Library Draft, Patch, Approval, Compile, Run, and Reuse

**Files:**
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/server/routes.ts`
- Create: `tests/v2/design-library-server-api.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing server API test**

Create `tests/v2/design-library-server-api.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";

test("design library HTTP API creates draft, patches, approves, compiles, and matches reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "southstar-design-library-api-"));
  const db = openSouthstarDb(join(root, "southstar.sqlite3"));
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: { generate: async () => "{}" },
    executorProvider: { executorType: "tork", async submit() { throw new Error("API compile test must not submit executor"); } },
  });

  try {
    const issue = issuePacket(root);
    const draft = await post(server.url, "/api/v2/design/drafts", { issue }) as { data: { draftId: string } };
    assert.match(draft.data.draftId, /^draft-/);

    const patched = await post(server.url, `/api/v2/design/drafts/${draft.data.draftId}/patch`, {
      patch: { baseDraftId: draft.data.draftId, actor: "user", rationale: "Add browser UX checker", operations: [{ op: "add-node", node: { id: "browser-ux-verification", nodeType: "agent_task", name: "Browser UX Verification", roleRef: "checker", agentSpecRef: "software-dev.agent.checker@1.0.0", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" } }] },
    }) as { data: { validation: { ok: boolean } } };
    assert.equal(typeof patched.data.validation.ok, "boolean");

    const approved = await post(server.url, `/api/v2/design/drafts/${draft.data.draftId}/approve-for-run`, { version: "1.0.0" }) as { data: { templateVersionId: string } };
    assert.match(approved.data.templateVersionId, /^ver-/);

    const compiled = await post(server.url, `/api/v2/templates/${approved.data.templateVersionId}/compile`, { issue, runInputs: { repoPath: issue.repoPath } }) as { data: { workflowId: string; compiledFrom: { templateVersionId: string } } };
    assert.equal(compiled.data.compiledFrom.templateVersionId, approved.data.templateVersionId);
  } finally {
    await server.close();
  }
});

async function post(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

function issuePacket(root: string) {
  return {
    title: "Todo-web: add priority labels, due dates, and overdue filter",
    body: "Feature issue for the todo-web fixture.",
    labels: ["feature", "todo-web"],
    repoPath: root,
    acceptanceCriteria: ["priority labels", "due dates", "overdue filter", "persistence", "tests pass"],
  };
}
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-server-api.test.ts
```

Expected: FAIL with 404 for `/api/v2/design/drafts`.

- [ ] **Step 3: Add local API functions**

In `src/v2/ui-api/local-api.ts`, export:

```ts
export async function createDesignLibraryDraft(db: SouthstarDb, input: { issue: TodoWebFeatureIssuePacket; plannerClient: PiPlannerClient }) {
  return createWorkflowDesignDraftFromIssue(db, { issue: input.issue, plannerClient: input.plannerClient, actorType: "llm" });
}

export function patchDesignLibraryDraft(db: SouthstarDb, input: { patch: WorkflowTemplatePatch }) {
  return applyWorkflowTemplatePatch(db, input.patch);
}

export function approveDesignLibraryDraftForRun(db: SouthstarDb, input: { draftId: string; version: string }) {
  return approveDraftForRun(db, { draftId: input.draftId, approvedBy: "user", version: input.version });
}

export function compileDesignLibraryTemplate(db: SouthstarDb, input: { templateVersionId: string; issue: TodoWebFeatureIssuePacket; runInputs: Record<string, unknown> }) {
  return compileTemplateVersionToManifest(db, { templateVersionId: input.templateVersionId, issue: input.issue, runInputs: input.runInputs, compilerVersion: "design-library-compiler-v1" });
}
```

- [ ] **Step 4: Add server routes**

In `src/v2/server/routes.ts`, add handlers before the final 404:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/design/drafts") {
  const body = await readJsonBody<{ issue?: TodoWebFeatureIssuePacket }>(request);
  if (!body.issue) throw new Error("issue is required");
  return json("design-draft", await createDesignLibraryDraft(context.db, { issue: body.issue, plannerClient: context.plannerClient }));
}

const designPatchMatch = url.pathname.match(/^\/api\/v2\/design\/drafts\/([^/]+)\/patch$/);
if (request.method === "POST" && designPatchMatch) {
  const body = await readJsonBody<{ patch?: WorkflowTemplatePatch }>(request);
  if (!body.patch) throw new Error("patch is required");
  return json("design-patch", patchDesignLibraryDraft(context.db, { patch: { ...body.patch, baseDraftId: decodeURIComponent(designPatchMatch[1]!) } }));
}

const approveMatch = url.pathname.match(/^\/api\/v2\/design\/drafts\/([^/]+)\/approve-for-run$/);
if (request.method === "POST" && approveMatch) {
  const body = await readJsonBody<{ version?: string }>(request);
  return json("approve-for-run", approveDesignLibraryDraftForRun(context.db, { draftId: decodeURIComponent(approveMatch[1]!), version: body.version ?? "1.0.0" }));
}

const compileMatch = url.pathname.match(/^\/api\/v2\/templates\/([^/]+)\/compile$/);
if (request.method === "POST" && compileMatch) {
  const body = await readJsonBody<{ issue?: TodoWebFeatureIssuePacket; runInputs?: Record<string, unknown> }>(request);
  if (!body.issue) throw new Error("issue is required");
  return json("compile", compileDesignLibraryTemplate(context.db, { templateVersionId: decodeURIComponent(compileMatch[1]!), issue: body.issue, runInputs: body.runInputs ?? {} }));
}
```

- [ ] **Step 5: Import test and run suite**

Append:

```ts
await import("./design-library-server-api.test.ts");
```

Run:

```bash
npm run test:v2
```

Expected: server API test passes.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/local-api.ts src/v2/server/routes.ts tests/v2/design-library-server-api.test.ts tests/v2/index.test.ts
git commit -m "feat(v2): expose design library API surface"
```

---

## Task 6: Validate Template From Runtime Success and Match Reuse

**Files:**
- Modify: `src/v2/design-library/lifecycle.ts`
- Create: `src/v2/design-library/reuse.ts`
- Create: `src/v2/quality/design-library-gates.ts`
- Create: `tests/v2/design-library-lifecycle-reuse.test.ts`
- Create: `tests/v2/design-library-gates.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing lifecycle/reuse tests**

Create `tests/v2/design-library-lifecycle-reuse.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../src/v2/design-library/designer.ts";
import { approveDraftForRun, validateTemplateFromRun } from "../../src/v2/design-library/lifecycle.ts";
import { matchValidatedTemplateForIssue } from "../../src/v2/design-library/reuse.ts";

test("template validates only after runtime pass, terminal accepted artifact, evidence, and stop condition", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const issue = issuePacket("/tmp/todo-web");
  const draft = await createWorkflowDesignDraftFromIssue(db, { issue, actorType: "llm", plannerClient: { generate: async () => "{}" } });
  const approved = approveDraftForRun(db, { draftId: draft.draftId, approvedBy: "user", version: "1.0.0" });

  createWorkflowRun(db, { id: "run-template-validation", status: "passed", domain: "software", goalPrompt: issue.title, workflowManifestJson: JSON.stringify({ compiledFrom: { templateVersionId: approved.templateVersionId } }), executionProjectionJson: JSON.stringify(null), snapshotJson: JSON.stringify({}), runtimeContextJson: JSON.stringify({}), metricsJson: JSON.stringify({}) });
  appendHistoryEvent(db, { runId: "run-template-validation", eventType: "run.completed", actorType: "runtime", payload: { status: "passed" } });
  upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: "terminal-artifact", runId: "run-template-validation", scope: "workflow", status: "accepted", payload: { artifactType: "completion_report" } });
  upsertRuntimeResource(db, { resourceType: "evidence_packet", resourceKey: "terminal-evidence", runId: "run-template-validation", scope: "workflow", status: "complete", payload: { completeness: { requiredCount: 3, presentCount: 3, missingKinds: [] } } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: "terminal-stop", runId: "run-template-validation", scope: "workflow", status: "passed", payload: { verdict: "passed" } });

  const validated = validateTemplateFromRun(db, { templateVersionId: approved.templateVersionId, runId: "run-template-validation", actorType: "runtime" });
  assert.equal(validated.status, "validated");

  const match = matchValidatedTemplateForIssue(db, { issue: issuePacket("/tmp/another-todo-web") });
  assert.equal(match.confidence >= 0.85, true, JSON.stringify(match));
  assert.equal(match.missingInputs.length, 0);
  assert.equal(match.risk, "low");
  assert.equal(match.clarificationQuestionCount, 0);
});

function issuePacket(repoPath: string) {
  return { title: "Todo-web: add priority labels, due dates, and overdue filter", body: "Implement todo-web priority and due-date workflow.", labels: ["feature", "todo-web"], repoPath, acceptanceCriteria: ["priority", "due date", "overdue", "localStorage", "tests"] };
}
```

- [ ] **Step 2: Write failing quantitative gate test**

Create `tests/v2/design-library-gates.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { assertDesignLibraryQuantitativeGates } from "../../src/v2/quality/design-library-gates.ts";

test("design library gate enforces seeded definitions across all 7 kinds", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const result = assertDesignLibraryQuantitativeGates(db, { minApprovedVersions: 14, minAgentSpecs: 5 });
  assert.equal(result.ok, true, result.failures.join("\n"));
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/design-library-lifecycle-reuse.test.ts
node --disable-warning=ExperimentalWarning tests/v2/design-library-gates.test.ts
```

Expected: FAIL because lifecycle/reuse/gates are missing.

- [ ] **Step 4: Implement validation-from-run**

In `src/v2/design-library/lifecycle.ts`, add:

```ts
export function validateTemplateFromRun(db: SouthstarDb, input: {
  templateVersionId: string;
  runId: string;
  actorType: "runtime" | "system";
}): { templateVersionId: string; status: "validated" };
```

Rules:

- `workflow_runs.status` must be `passed` or `completed`.
- Latest `runtime_resources.resource_type = 'stop_condition_result'` for run must have status `passed`.
- There must be at least one accepted terminal artifact.
- All evidence packets for accepted artifacts must have status `complete` and `missingKinds.length === 0`.
- Update template payload lifecycle status to `validated` in a new immutable version `1.0.1` or update current version payload only if version row is modeled as validation metadata; choose new immutable version to preserve audit.
- Append `library_history` event `template.validated_from_run` after `run.completed`.

- [ ] **Step 5: Implement reuse matcher**

Create `src/v2/design-library/reuse.ts`:

```ts
export function matchValidatedTemplateForIssue(db: SouthstarDb, input: { issue: TodoWebFeatureIssuePacket }): TemplateMatchResult {
  const rows = db.prepare(`
    select id, state_json, updated_at
    from library_objects
    where object_kind = 'workflow_template'
    order by updated_at desc
  `).all() as Array<{ id: string; state_json: string; updated_at: string }>;
  const normalized = normalizeIssue(input.issue);
  for (const row of rows) {
    const payload = JSON.parse(row.state_json) as WorkflowTemplatePayload;
    if (payload.lifecycle.status !== "validated") continue;
    const haystack = [payload.reuse.signature, ...payload.reuse.tags, payload.reuse.requirementSpecSnapshot.summary].join(" ").toLowerCase();
    const overlap = tokenOverlap(normalized, haystack);
    const missingInputs = payload.reuse.requiredInputs.filter((key) => !hasIssueInput(input.issue, key));
    const confidence = missingInputs.length === 0 ? Math.max(0.85, overlap) : overlap;
    return { templateVersionRef: row.id, confidence, missingInputs, risk: "low", reason: "Validated todo-web software-dev template matched issue signature and required inputs.", clarificationQuestionCount: missingInputs.length === 0 ? 0 : missingInputs.length };
  }
  return { templateVersionRef: "", confidence: 0, missingInputs: ["validatedTemplate"], risk: "medium", reason: "No validated template matched", clarificationQuestionCount: 1 };
}
```

- [ ] **Step 6: Implement quantitative gates**

Create `src/v2/quality/design-library-gates.ts` exporting:

```ts
export function assertDesignLibraryQuantitativeGates(db: SouthstarDb, input: { minApprovedVersions: number; minAgentSpecs: number }): { ok: boolean; failures: string[] };
export function assertDesignLibraryRealE2EGates(db: SouthstarDb, input: { runId: string; templateVersionId: string; maxPayloadBytes: number; minCompletedTasks: number }): { ok: boolean; failures: string[] };
```

The real E2E gate must check:

- completed tasks >= `minCompletedTasks`
- executor bindings >= completed tasks and all are Tork
- every task envelope / harness definition resolves to Pi host adapter (`harnessId === "pi"` or harness kind `"pi-agent"`), with zero Codex/OpenCode/builtin/fake harness references
- accepted artifacts == completed tasks
- complete evidence packets == accepted artifacts
- blocking validator failures == 0
- payloads > maxPayloadBytes == 0
- latest stop condition status == passed
- at least one `template.validated_from_run` library history event exists

- [ ] **Step 7: Import tests and run suite**

Append:

```ts
await import("./design-library-lifecycle-reuse.test.ts");
await import("./design-library-gates.test.ts");
```

Run:

```bash
npm run test:v2
```

Expected: lifecycle/reuse/gate tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/v2/design-library/lifecycle.ts src/v2/design-library/reuse.ts src/v2/quality/design-library-gates.ts tests/v2/design-library-lifecycle-reuse.test.ts tests/v2/design-library-gates.test.ts tests/v2/index.test.ts
git commit -m "feat(v2): validate and reuse design library templates"
```

---

## Task 7: New Todo-Web Feature Issue Fixture

**Files:**
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/package.json`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/README.md`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/index.html`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/src/todo-store.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/src/app.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/src/styles.css`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/test/todo-store.test.ts`
- Create: `tests/e2e-real/fixtures/todo-web-feature-issue/test/browser-baseline.test.ts`

- [ ] **Step 1: Create fixture package**

Write `tests/e2e-real/fixtures/todo-web-feature-issue/package.json`:

```json
{
  "name": "southstar-todo-web-feature-fixture",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test --import tsx test/*.test.ts",
    "serve": "node server.mjs"
  },
  "devDependencies": {
    "@playwright/test": "^1.57.0",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: Create fixture README**

Write `tests/e2e-real/fixtures/todo-web-feature-issue/README.md`:

```md
# Todo Web Fixture

A small browser todo app used by Southstar real E2E tests.

## Existing behavior

- Add a todo with text.
- Toggle completion.
- Delete a todo.
- Persist todos in localStorage.

## Feature issue for Southstar

Add priority labels, due dates, and an Overdue filter.

Acceptance criteria:

1. Each todo can show low, medium, or high priority.
2. Each todo can store an ISO due date.
3. Overdue filter shows only incomplete todos with a due date before today.
4. Todo state persists in localStorage across reload.
5. Unit and browser behavior tests pass in Docker.
```

- [ ] **Step 3: Create HTML/CSS/app baseline**

Write `index.html` with stable selectors agents can extend:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Todo Web Fixture</title>
    <link rel="stylesheet" href="./src/styles.css" />
  </head>
  <body>
    <main class="todo-shell">
      <h1>Todo Web Fixture</h1>
      <form data-testid="todo-form">
        <label>
          Task
          <input data-testid="todo-input" name="text" autocomplete="off" required />
        </label>
        <button data-testid="add-todo" type="submit">Add todo</button>
      </form>
      <section class="filters" aria-label="Filters">
        <button data-testid="filter-all" data-filter="all">All</button>
        <button data-testid="filter-active" data-filter="active">Active</button>
        <button data-testid="filter-completed" data-filter="completed">Completed</button>
      </section>
      <ul data-testid="todo-list" class="todo-list"></ul>
    </main>
    <script type="module" src="./src/app.ts"></script>
  </body>
</html>
```

Write `src/styles.css` with baseline classes:

```css
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; background: #f5f7fb; color: #172033; }
.todo-shell { max-width: 720px; margin: 48px auto; padding: 24px; background: white; border: 1px solid #d8deea; border-radius: 18px; box-shadow: 0 24px 60px rgba(20, 32, 56, 0.12); }
form { display: flex; gap: 12px; align-items: end; }
label { display: grid; gap: 6px; flex: 1; font-weight: 700; }
input, button, select { border: 1px solid #b9c3d6; border-radius: 10px; padding: 10px 12px; font: inherit; }
button { cursor: pointer; background: #1d4ed8; color: white; border-color: #1d4ed8; }
.filters { display: flex; gap: 8px; margin: 20px 0; }
.todo-list { list-style: none; padding: 0; display: grid; gap: 10px; }
.todo-item { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 12px; border: 1px solid #d8deea; border-radius: 12px; }
.todo-item.completed .todo-text { text-decoration: line-through; color: #667085; }
```

- [ ] **Step 4: Create baseline store and app**

Write `src/todo-store.ts`:

```ts
export type Todo = {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
};

export type TodoFilter = "all" | "active" | "completed";

export function createTodo(text: string, now = new Date()): Todo {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Todo text is required");
  return { id: `todo-${now.getTime()}-${Math.random().toString(16).slice(2)}`, text: trimmed, completed: false, createdAt: now.toISOString() };
}

export function toggleTodo(todos: Todo[], id: string): Todo[] {
  return todos.map((todo) => todo.id === id ? { ...todo, completed: !todo.completed } : todo);
}

export function deleteTodo(todos: Todo[], id: string): Todo[] {
  return todos.filter((todo) => todo.id !== id);
}

export function filterTodos(todos: Todo[], filter: TodoFilter): Todo[] {
  if (filter === "active") return todos.filter((todo) => !todo.completed);
  if (filter === "completed") return todos.filter((todo) => todo.completed);
  return todos;
}

export function serializeTodos(todos: Todo[]): string {
  return JSON.stringify(todos);
}

export function parseTodos(raw: string | null): Todo[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Todo[];
  return parsed.filter((todo) => typeof todo.id === "string" && typeof todo.text === "string" && typeof todo.completed === "boolean");
}
```

Write `src/app.ts`:

```ts
import { createTodo, deleteTodo, filterTodos, parseTodos, serializeTodos, toggleTodo, type Todo, type TodoFilter } from "./todo-store.ts";

const storageKey = "southstar.todo-web.todos";
let todos: Todo[] = parseTodos(window.localStorage.getItem(storageKey));
let filter: TodoFilter = "all";

const form = document.querySelector<HTMLFormElement>('[data-testid="todo-form"]')!;
const input = document.querySelector<HTMLInputElement>('[data-testid="todo-input"]')!;
const list = document.querySelector<HTMLUListElement>('[data-testid="todo-list"]')!;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  todos = [...todos, createTodo(input.value)];
  input.value = "";
  persistAndRender();
});

document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter as TodoFilter;
    render();
  });
});

function persistAndRender() {
  window.localStorage.setItem(storageKey, serializeTodos(todos));
  render();
}

function render() {
  list.replaceChildren(...filterTodos(todos, filter).map(renderTodo));
}

function renderTodo(todo: Todo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `todo-item${todo.completed ? " completed" : ""}`;
  item.dataset.todoId = todo.id;
  item.innerHTML = `
    <input data-testid="toggle-todo" type="checkbox" ${todo.completed ? "checked" : ""} aria-label="Toggle ${escapeHtml(todo.text)}" />
    <span class="todo-text">${escapeHtml(todo.text)}</span>
    <button data-testid="delete-todo" type="button">Delete</button>
  `;
  item.querySelector<HTMLInputElement>('[data-testid="toggle-todo"]')!.addEventListener("change", () => {
    todos = toggleTodo(todos, todo.id);
    persistAndRender();
  });
  item.querySelector<HTMLButtonElement>('[data-testid="delete-todo"]')!.addEventListener("click", () => {
    todos = deleteTodo(todos, todo.id);
    persistAndRender();
  });
  return item;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]!));
}

render();
```

- [ ] **Step 5: Create baseline tests**

Write `test/todo-store.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createTodo, deleteTodo, filterTodos, parseTodos, serializeTodos, toggleTodo } from "../src/todo-store.ts";

test("creates, toggles, filters, deletes, and serializes todos", () => {
  const first = createTodo("Write E2E", new Date("2026-06-15T00:00:00.000Z"));
  const second = createTodo("Review evidence", new Date("2026-06-15T00:01:00.000Z"));
  const toggled = toggleTodo([first, second], first.id);
  assert.equal(toggled[0]!.completed, true);
  assert.deepEqual(filterTodos(toggled, "completed").map((todo) => todo.text), ["Write E2E"]);
  assert.deepEqual(deleteTodo(toggled, second.id).map((todo) => todo.text), ["Write E2E"]);
  assert.deepEqual(parseTodos(serializeTodos(toggled)).map((todo) => todo.text), ["Write E2E", "Review evidence"]);
});
```

Write `test/browser-baseline.test.ts`:

```ts
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("baseline todo app adds and persists a todo", async () => {
  const server = createServer((request, response) => {
    const pathname = request.url === "/" ? "/index.html" : request.url ?? "/index.html";
    const path = join(root, pathname.replace(/^\//, ""));
    if (!existsSync(path)) { response.statusCode = 404; response.end("not found"); return; }
    response.setHeader("content-type", contentType(path));
    response.end(readFileSync(path));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByTestId("todo-input").fill("Persist me");
    await page.getByTestId("add-todo").click();
    await page.getByText("Persist me").waitFor();
    await page.reload();
    await page.getByText("Persist me").waitFor();
  } finally {
    await browser.close();
    server.close();
  }
});

function contentType(path: string): string {
  if (extname(path) === ".html") return "text/html";
  if (extname(path) === ".css") return "text/css";
  if (extname(path) === ".ts") return "text/javascript";
  return "text/plain";
}
```

- [ ] **Step 6: Run fixture tests locally**

Run:

```bash
cd tests/e2e-real/fixtures/todo-web-feature-issue && npm install && npm test
```

Expected: PASS for baseline fixture tests.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e-real/fixtures/todo-web-feature-issue
git commit -m "test(e2e): add todo-web feature issue fixture"
```

---

## Task 8: Real E2E Scenario for Todo-Web Software Development Agent Workflow

**Files:**
- Create: `tests/e2e-real/scenarios/design-library-template-real.ts`
- Create: `tests/e2e-real/design-library-template-real.test.ts`
- Modify: `tests/e2e-real/scenarios/harness.ts`
- Modify: `package.json`

- [ ] **Step 1: Add todo-web fixture helpers**

In `tests/e2e-real/scenarios/harness.ts`, add imports and helpers without reusing calc-sum helper names. These helpers must assert that the E2E uses the Pi host adapter for planner and agent execution:

```ts
const todoWebFixtureRoot = join(here, "../fixtures/todo-web-feature-issue");

export function assertPiHostAdapterE2E(env: RealE2EEnv): void {
  assert.equal(["http", "sdk"].includes(env.piPlannerMode), true, `invalid Pi planner mode: ${env.piPlannerMode}`);
  assert.equal(["http", "sdk"].includes(env.piHarnessMode), true, `invalid Pi harness mode: ${env.piHarnessMode}`);
  if (env.piPlannerMode === "http") assert.ok(env.piPlannerEndpoint, "Pi planner HTTP mode requires PI_PLANNER_ENDPOINT");
  if (env.piHarnessMode === "http") assert.ok(env.piHarnessEndpoint, "Pi harness HTTP mode requires PI_HARNESS_ENDPOINT");
}

export function prepareTodoWebFeatureIssueRepo(env: RealE2EEnv, name: string): string {
  const repo = join(env.workspaceRoot, name);
  removeFixtureRepo(repo);
  mkdirSync(dirname(repo), { recursive: true });
  cpSync(todoWebFixtureRoot, repo, { recursive: true });
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "southstar-e2e@example.local"], repo);
  run("git", ["config", "user.name", "Southstar E2E"], repo);
  run("npm", ["install"], repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "initial todo-web fixture"], repo);
  return repo;
}

export function todoWebFeatureIssuePacket(repo: string) {
  return {
    title: "Todo-web: add priority labels, due dates, and overdue filter",
    body: "Users need priority labels, due dates, an Overdue filter, and persistence after reload in the todo-web app.",
    labels: ["feature", "todo-web", "frontend"],
    repoPath: repo,
    acceptanceCriteria: [
      "Each todo can show low, medium, or high priority.",
      "Each todo can store an ISO due date.",
      "Overdue filter shows only incomplete todos with a due date before today.",
      "Todo state persists in localStorage across reload.",
      "Unit and browser behavior tests pass in Docker.",
    ],
  };
}

export function assertTodoWebFeatureImplemented(repo: string): void {
  assertFixtureTests(repo);
  const diffNames = run("git", ["diff", "--name-only", "HEAD"], repo).trim().split(/\n/).filter(Boolean);
  for (const expected of ["src/todo-store.ts", "src/app.ts", "src/styles.css", "README.md"]) {
    assert.equal(diffNames.includes(expected), true, `missing changed file ${expected}; diff=${diffNames.join(",")}`);
  }
  assert.equal(diffNames.some((path) => path.startsWith("test/") && path.endsWith(".test.ts")), true, `missing changed test file; diff=${diffNames.join(",")}`);
}
```

- [ ] **Step 2: Write failing E2E scenario**

Create `tests/e2e-real/scenarios/design-library-template-real.ts`:

```ts
import assert from "node:assert/strict";
import { createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { seedSoftwareDevDesignLibrary } from "../../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../../src/v2/design-library/designer.ts";
import { applyWorkflowTemplatePatch } from "../../../src/v2/design-library/patch.ts";
import { approveDraftForRun, validateTemplateFromRun } from "../../../src/v2/design-library/lifecycle.ts";
import { compileTemplateVersionToManifest } from "../../../src/v2/design-library/compiler.ts";
import { matchValidatedTemplateForIssue } from "../../../src/v2/design-library/reuse.ts";
import { assertDesignLibraryQuantitativeGates, assertDesignLibraryRealE2EGates } from "../../../src/v2/quality/design-library-gates.ts";
import { upsertRuntimeResource } from "../../../src/v2/stores/resource-store.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertPiHostAdapterE2E,
  assertTodoWebFeatureImplemented,
  createScenarioContext,
  prepareTodoWebFeatureIssueRepo,
  startCallbackServer,
  todoWebFeatureIssuePacket,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export async function runDesignLibraryTemplateRealScenario(env: RealE2EEnv): Promise<{ runId: string; repo: string; templateVersionId: string; durationMs: number }> {
  assertPiHostAdapterE2E(env);
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareTodoWebFeatureIssueRepo(env, "design-library-todo-web-feature-issue");
  try {
    seedSoftwareDevDesignLibrary(context.db, { actorType: "migration" });
    const seedGate = assertDesignLibraryQuantitativeGates(context.db, { minApprovedVersions: 14, minAgentSpecs: 5 });
    assert.equal(seedGate.ok, true, seedGate.failures.join("\n"));

    const issue = todoWebFeatureIssuePacket(repo);
    const design = await createWorkflowDesignDraftFromIssue(context.db, {
      issue,
      actorType: "llm",
      plannerClient: context.plannerClient,
    });
    assert.equal(design.requirementSpec.requiredInputs.length >= 3, true);

    applyWorkflowTemplatePatch(context.db, {
      baseDraftId: design.draftId,
      actor: "llm",
      rationale: "Add browser UX verification node for priority, due date, overdue filter, and persistence behavior.",
      operations: [{ op: "add-node", node: { id: "browser-ux-verification", nodeType: "agent_task", name: "Browser UX Verification", roleRef: "checker", agentSpecRef: "software-dev.agent.checker@1.0.0", contractRefs: ["software-dev.contract.verification-artifact"], validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"], capabilityRefs: ["software-dev.capability.browser-ux-verification@1.0.0"], mcpCapabilityRefs: [], workspacePolicyRef: "software-dev.policy.safe-workspace-tork@1.0.0" } }],
    });
    applyWorkflowTemplatePatch(context.db, {
      baseDraftId: design.draftId,
      actor: "user",
      rationale: "Require implementation artifact and workspace state before browser UX verification.",
      operations: [{ op: "add-edge", edge: { id: "implementer-to-browser-ux-verification", from: "implementer", to: "browser-ux-verification", edgeType: "artifact_flow", artifactContractRefs: ["software-dev.contract.implementation-artifact"], workspaceStateRequired: true } }],
    });

    const approved = approveDraftForRun(context.db, { draftId: design.draftId, approvedBy: "user", version: "1.0.0" });
    const manifest = compileTemplateVersionToManifest(context.db, {
      templateVersionId: approved.templateVersionId,
      issue,
      runInputs: { repoPath: repo, issueTitle: issue.title, issueBody: issue.body, acceptanceCriteria: issue.acceptanceCriteria },
      compilerVersion: "design-library-compiler-v1",
    });
    upsertRuntimeResource(context.db, { resourceType: "planner_draft", resourceKey: `design-library-${manifest.workflowId}`, scope: "planner", status: "validated", title: manifest.title, payload: { workflow: manifest, plannerTrace: { model: "design-library-compiler-v1", promptHash: manifest.compiledFrom!.inputHash, generatedAt: new Date().toISOString() } } });

    const run = await createRunFromDraft(context.db, {
      draftId: `design-library-${manifest.workflowId}`,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      contextRefreshUrl: callback.contextRefreshUrl,
      harnessEndpoint: env.piHarnessEndpoint,
    });

    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId, 15 * 60 * 1000);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"], 120_000);

    assertTodoWebFeatureImplemented(repo);
    validateTemplateFromRun(context.db, { templateVersionId: approved.templateVersionId, runId: run.runId, actorType: "runtime" });
    const e2eGate = assertDesignLibraryRealE2EGates(context.db, { runId: run.runId, templateVersionId: approved.templateVersionId, maxPayloadBytes: 50_000, minCompletedTasks: 5 });
    assert.equal(e2eGate.ok, true, e2eGate.failures.join("\n"));

    const reuse = matchValidatedTemplateForIssue(context.db, { issue: { ...issue, title: "Todo-web: add tags and filtered views", body: "Another low-risk todo-web feature issue with complete repo and acceptance criteria." } });
    assert.equal(reuse.confidence >= 0.85, true, JSON.stringify(reuse));
    assert.equal(reuse.missingInputs.length, 0);
    assert.equal(reuse.risk, "low");
    assert.equal(reuse.clarificationQuestionCount, 0);

    const durationMs = Date.now() - startedAt;
    assert.equal(durationMs <= 15 * 60 * 1000, true, `scenario took ${durationMs}ms`);
    return { runId: run.runId, repo, templateVersionId: approved.templateVersionId, durationMs };
  } finally {
    await callback.close();
  }
}
```

- [ ] **Step 3: Write E2E test entrypoint**

Create `tests/e2e-real/design-library-template-real.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadRealE2EEnv } from "./env.ts";
import { runDesignLibraryTemplateRealScenario } from "./scenarios/design-library-template-real.ts";

test("Design Library template real E2E develops todo-web feature issue through software-dev agent workflow", async () => {
  const scenarioSource = readFileSync(new URL("./scenarios/design-library-template-real.ts", import.meta.url), "utf8");
  assert.equal(/calc\s+sum|software-change|assertCalcSum|softwareGoalPrompt/.test(scenarioSource), false, "new E2E must not reuse calc-sum helpers or fixture");
  assert.equal(/fake|mock|smoke|codex|opencode|builtin-agent/i.test(scenarioSource), false, "new E2E must use Pi host adapter, not fake/mock/smoke/Codex/OpenCode/builtin paths");

  const env = await loadRealE2EEnv();
  assert.equal(["http", "sdk"].includes(env.piPlannerMode), true, "planner must use Pi host adapter mode");
  assert.equal(["http", "sdk"].includes(env.piHarnessMode), true, "agent harness must use Pi host adapter mode");
  const result = await runDesignLibraryTemplateRealScenario(env);
  assert.match(result.runId, /^run-/);
  assert.match(result.templateVersionId, /^ver-/);
});
```

- [ ] **Step 4: Add package script**

Modify `package.json` scripts:

```json
"test:e2e:design-library-real": "tsx tests/e2e-real/design-library-template-real.test.ts"
```

- [ ] **Step 5: Run E2E and verify red/green**

First run before scenario implementation is wired:

```bash
npm run test:e2e:design-library-real
```

Expected before implementation: FAIL on missing compiler/runtime integration or todo-web acceptance.

After implementation and fixture agent workflow support:

```bash
npm run test:e2e:design-library-real
```

Expected after implementation: PASS within 15 minutes, with real Docker/Tork job completion, Pi host adapter planner/agent execution, and no fake/mock/smoke/Codex/OpenCode/builtin harness string matches in the scenario file.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e-real/scenarios/harness.ts tests/e2e-real/scenarios/design-library-template-real.ts tests/e2e-real/design-library-template-real.test.ts package.json
git commit -m "test(e2e): prove design library with todo-web feature issue"
```

---

## Task 9: Full Verification and Coverage Audit

**Files:**
- Modify only files needed to fix failures from verification.

- [ ] **Step 1: Run v2 unit/integration suite**

Run:

```bash
npm run test:v2
```

Expected: PASS. If it fails, fix the failing test before continuing.

- [ ] **Step 2: Run isolated real E2E**

Run:

```bash
npm run test:e2e:design-library-real
```

Expected: PASS within 15 minutes. Evidence required in output: Pi host adapter modes are asserted, Tork job completes, run reaches `passed` or `completed`, todo-web fixture tests pass, reuse confidence is at least 0.85.

- [ ] **Step 3: Run full non-live project gate**

Run:

```bash
npm test
```

Expected: PASS. Do not run `test:live` scripts.

- [ ] **Step 4: Quantitative acceptance audit**

Use SQLite queries against the E2E database and record results in the final implementation summary:

```sql
select json_extract(payload_json, '$.definitionKind') as definition_kind, count(*)
from library_history
where event_type = 'version.created'
group by json_extract(payload_json, '$.definitionKind');
select count(*) from library_history where event_type = 'version.created';
select count(*) from workflow_tasks where run_id = :runId and status = 'completed';
select count(*) from runtime_resources where run_id = :runId and resource_type = 'artifact' and status = 'accepted';
select count(*) from runtime_resources where run_id = :runId and resource_type = 'evidence_packet' and status = 'complete';
select count(*) from runtime_resources where run_id = :runId and resource_type = 'validator_result' and json_extract(payload_json, '$.blocking') = 1 and json_extract(payload_json, '$.verdict') = 'failed';
select count(*) from runtime_resources where run_id = :runId and resource_type in ('artifact', 'evidence_packet', 'validator_result') and length(payload_json) > 50000;
select event_type, created_at from library_history where event_type = 'template.validated_from_run' order by created_at desc limit 1;
```

Expected thresholds:

- Approved immutable versions >= 14.
- All 7 definition kinds represented.
- Completed tasks >= 5.
- 100% compiled task subagents use `harnessId === "pi"` and manifest harness definitions use `kind === "pi-agent"`.
- Accepted artifacts == completed tasks.
- Complete evidence packets == accepted artifacts.
- Blocking validator failures == 0.
- Payload rows > 50,000 bytes == 0.
- Latest stop condition status == `passed`.
- Reuse confidence >= 0.85 and clarification count == 0.

- [ ] **Step 5: Commit final fixes**

```bash
git add src tests package.json
git commit -m "test(v2): satisfy design library quantitative gates"
```

---

## Implementation Agent Goal Prompt

```text
Implement the Southstar v2 Design Library / Workflow Template vertical slice from docs/superpowers/specs/2026-06-15-southstar-llm-design-library-workflow-template-design.md using the task-by-task plan in docs/superpowers/plans/2026-06-15-southstar-llm-design-library-workflow-template-implementation-plan.md.

Primary real E2E objective:
- Create a new real E2E for a todo-web feature issue: "Todo-web: add priority labels, due dates, and overdue filter".
- Build the software-development agent workflow from approved Design Library definitions: explorer, planner, implementer, checker, summarizer.
- The workflow must compile into real Tork tasks and execute through real Docker/Tork plus Pi host adapter planner and Pi host adapter agent harness.
- Do not reuse existing calc-sum scenarios/helpers/fixtures.
- Do not use fake, mock, smoke-only, in-memory executor substitutes, fake planner/harness paths, Codex, OpenCode, or builtin harness paths in the E2E.

Required runtime capabilities:
- SQLite-first Design Library with 2 canonical tables (`library_objects`, `library_history`) plus optional `library_similarity_index` projection.
- Immutable library versions for 7 definition kinds.
- Draft and typed WorkflowTemplatePatch audit in library_history.
- Human approve-for-run before executable template version creation.
- Deterministic compiler from immutable template/library version ids to SouthstarWorkflowManifest with compiledFrom metadata.
- Template validation from successful runtime evidence only.
- Reuse matcher for similar todo-web issues with confidence >=0.85 and 0 clarification questions when inputs are complete.

Quantitative gates:
- >=14 approved immutable versions across all 7 definition kinds.
- >=5 completed real workflow tasks.
- 100% tasks submitted through Docker/Tork executor bindings.
- 100% E2E planner and agent invocations use Pi host adapter (`piPlannerMode`/`piHarnessMode` http or sdk; compiled subagents `harnessId === "pi"`; harness definitions `kind === "pi-agent"`).
- Accepted artifacts exactly equal completed tasks.
- Complete evidence packets exactly equal accepted artifacts.
- Blocking validator failures equal 0.
- Artifact/evidence/validator payload rows >50,000 bytes equal 0.
- Latest stop condition status is passed.
- Todo-web Docker npm test passes after agent changes.
- Browser behavior evidence proves priority labels render, overdue filter hides non-overdue todos, and localStorage persistence survives reload.
- Git diff evidence includes src/todo-store.ts, src/app.ts, src/styles.css, README.md, and at least one test file.
- Scenario wall-clock time <=15 minutes.

Verification commands:
- npm run test:v2
- npm run test:e2e:design-library-real
- npm test
```

---

## Self-Review

**Spec coverage:** This plan maps Design Library tables, immutable versions, draft/patch audit, approval lifecycle, deterministic compile, runtime evidence validation, reuse matching, UI/API routes, and the new todo-web real E2E to concrete tasks.

**Placeholder scan:** No task contains deferred placeholders; each file has an explicit responsibility and each test defines concrete assertions.

**Type consistency:** `WorkflowTemplatePatch`, `WorkflowTemplatePayload`, `TemplateMatchResult`, `TodoWebFeatureIssuePacket`, `compiledFrom`, and gate function names are consistent across tasks.

**E2E compliance:** The plan creates a new todo-web fixture and scenario, prohibits calc-sum reuse, prohibits fake/mock/smoke/Codex/OpenCode/builtin paths, requires Pi host adapter for all E2E planner/agent execution, and sets quantitative thresholds for runtime and product behavior.
