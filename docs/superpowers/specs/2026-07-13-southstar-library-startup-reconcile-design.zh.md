# Southstar Library Startup Reconcile Design

**Date:** 2026-07-13

**Status:** Approved design; implementation plan pending

**Decision:** Git-managed Library files whose metadata declares `status: approved` are deployment-approved content. Southstar reconciles their valid, closed graph projection before the runtime accepts Goal traffic.

## 1. Summary

Southstar currently has two Library states:

1. authoring files under `library/`;
2. executable truth in the Postgres Library graph.

Workflow and Goal APIs correctly read only the Postgres graph, but `southstar:start` does not synchronize approved files into that graph. A repository may therefore contain a valid approved `southstar-goal-design` skill while `/api/v2/run-goal` fails with `expected exactly one approved Goal Design skill, found 0`.

The fix is a generic Library startup reconcile phase. It discovers every supported Library file, parses and validates it, projects valid file-backed lifecycle state, computes a reference-closed approved executable set, atomically reconciles graph objects and edges, persists a sync snapshot, and only then marks the runtime ready. It does not use seed content, fixtures, hardcoded object ids, domain-specific lists, placeholder objects, or an LLM fallback.

## 2. Current Evidence And Root Cause

The approved file exists and validates:

- `library/skills/southstar-goal-design.skill.md`;
- `status: approved`;
- `purpose: goal_design`;
- no parser or schema issues.

The running Postgres graph does not contain `skill.southstar-goal-design`. `loadGoalDesignSkillPg()` queries approved `skill_spec` objects, filters by `state.purpose === "goal_design"`, and fails unless exactly one object remains.

The browser is not responsible for executing this skill. The active request path is:

```text
Workflow chat
  -> POST /api/workflow/generate
  -> POST /api/v2/run-goal
  -> preparePostgresGoalDesignDraft
  -> loadGoalDesignSkillPg
  -> Goal Contract interpreter prompt
  -> Goal Design prompt
```

Existing E2E cases hide the production gap by calling test-local Library sync helpers before `/run-goal`. The managed startup path has no equivalent generic reconcile.

## 3. Goals

1. A normal `southstar:start` makes approved repository Library content available to Goal and Workflow APIs without an E2E-only setup step.
2. Runtime startup is ready only after one atomic, auditable Library reconcile succeeds.
3. Runtime code remains graph-backed and never falls back to reading raw files during Goal execution.
4. Exactly one approved `purpose: goal_design` skill is present in the reconciled executable set.
5. All synchronization entry points use one service and the same validation, closure, version, lifecycle, and history rules.
6. Existing runs remain immutable because their captured Library snapshots do not change.
7. Invalid or incomplete Library content produces structured diagnostics instead of a generic workflow-generation error.

## 4. Non-Goals

- Reintroducing `software-library-seed.ts`, domain packs, fixture composers, mock runtime objects, or fallback planners.
- Hardcoding `skill.southstar-goal-design`, concrete domain ids, task ids, agents, tools, artifacts, or templates in the reconcile algorithm.
- Letting the browser send a skill body or choose the Goal Design skill.
- Synchronizing files on every `/run-goal` request.
- Mutating the Postgres schema during runtime startup.
- Changing an existing run's frozen Library snapshot after reconcile.

## 5. Authority Model

The repository is the deployment authoring source for file-backed Library content:

- `status: approved` means the file is authorized for deployment reconciliation;
- `draft`, `deprecated`, and `blocked` remain non-executable lifecycle states;
- an approved file must still pass schema, reference, closure, and readiness validation;
- Library import remains reviewable and writes files only after its existing approval flow;
- a committed or locally approved file is not execution truth until a successful reconcile snapshot includes it.

Postgres remains the runtime source of truth. Goal interpretation, composition, scheduling, task materialization, and Operator read models continue reading graph objects and captured snapshots rather than raw files.

## 6. Recommended Architecture

Add one deep service boundary, tentatively named `LibraryReconcileService`, with no UI or lifecycle policy embedded in its parser/store internals.

```ts
type LibraryReconcileResult = {
  schemaVersion: "southstar.library_sync_snapshot.v1";
  snapshotHash: string;
  status: "ready" | "ready_with_warnings";
  sourceRoot: string;
  included: Array<{
    path: string;
    objectKey: string;
    objectKind: LibraryDefinitionKind;
    sourceHash: string;
    versionRef: string;
  }>;
  excluded: Array<{
    path: string;
    objectKey?: string;
    reason: string;
    missingRefs: string[];
  }>;
  deprecatedObjectKeys: string[];
  warnings: string[];
};
```

The service has three independently testable responsibilities:

1. **Discovery and parsing** — enumerate supported file suffixes, parse every file, and retain source-path evidence.
2. **Closed-set resolution** — compute which approved records can form a valid graph without inventing missing objects.
3. **Transactional reconcile** — upsert objects first, reconcile edges second, deprecate removed file-backed objects, and persist one snapshot/history result.

The existing single-file sync, Library UI `Save & Sync`, import approval, and startup code call this service rather than preserving separate synchronization semantics.

## 7. Normal Product Flow

```text
southstar:start
  -> start/validate Postgres infrastructure
  -> acquire Library reconcile advisory lock
  -> discover library/**/* supported files
  -> parse and schema-validate files
  -> project valid file-backed lifecycle records
  -> select status: approved executable candidates
  -> compute reference-closed set
  -> validate required runtime-purpose cardinality
  -> transactionally reconcile objects, edges, lifecycle, history
  -> persist library_sync_snapshot + current readiness pointer
  -> release advisory lock
  -> start runtime API and managed loops
  -> start web UI

POST /api/v2/run-goal
  -> require current successful Library readiness
  -> load the unique approved Goal Design skill from Postgres
  -> interpret Goal Contract
  -> produce evaluator contracts, Slice Plan, and strategy
  -> continue through composer/compiler/runtime
```

`/run-goal` performs no filesystem scan and no graph mutation. It is a consumer of the current successful reconcile snapshot.

## 8. Discovery And Validation

The reconcile discovers every suffix already supported by the Library file store:

- agent;
- skill;
- tool;
- MCP grant;
- vault policy;
- generated profile;
- workflow template;
- domain taxonomy;
- capability specification;
- artifact contract;
- evaluator profile.

Rules:

- invalid draft files are reported but do not enter the authoring projection or approved set;
- any file declaring `status: approved` but failing parser/schema validation makes reconcile fail;
- duplicate `objectKey` values make reconcile fail with both source paths;
- file ordering has no semantic effect;
- symlink/path traversal constraints remain enforced by the existing Library file APIs;
- no object or edge is written during discovery or closure calculation.

## 9. Closed Approved Set

Reference closure is calculated from parsed records, not from an object-id allowlist.

The graph authoring projection and executable set are distinct. Schema-valid `draft`, `deprecated`, and `blocked` files may be synchronized for Library UI/lifecycle truth, but they cannot enter runtime candidate resolution. Reference closure begins with all schema-valid approved records:

1. Begin with all schema-valid approved records.
2. Build the set of object keys defined by those records.
3. For each record, inspect its typed graph references.
4. Exclude records whose required non-domain refs are absent.
5. Repeat until no additional record becomes unclosed.
6. Return included and excluded records with paths and missing refs.

Domain, capability, artifact, evaluator, Agent, Skill, Tool, MCP, Vault, profile, and template records use the same parsed reference vocabulary. Optional template/profile content may be excluded with warnings when it is not needed for runtime readiness. The algorithm never creates placeholder objects.

After closure, runtime-purpose invariants are evaluated by metadata rather than concrete ids:

- exactly one included approved `skill_spec` has `purpose: goal_design`;
- exactly one included approved `skill_spec` has `purpose: composer_guidance`;
- every required runtime-purpose object has a non-null version ref and non-empty body/instructions where applicable.

Missing, duplicate, or unclosed Goal Design purpose records make the reconcile not ready.

## 10. Transactional Graph Reconcile

One Postgres transaction performs the entire graph update:

1. acquire a stable Postgres advisory lock before reading the current file-backed graph state;
2. upsert every included object with `headVersionId = objectKey@sourceHashPrefix`;
3. preserve an explicit lifecycle block/deprecation when an unchanged version is re-synced;
4. reconcile outgoing file-sourced edges only after all included objects exist;
5. deactivate obsolete edges for each source file;
6. mark removed file-backed objects `deprecated` instead of deleting them;
7. deactivate edges from deprecated removed objects;
8. append Library history and persist the sync snapshot/readiness resource;
9. commit as one unit.

If any write or reference check fails, the transaction rolls back. The prior successful graph and readiness snapshot remain authoritative.

The reconcile only manages objects proven to be file-backed by their source provenance. It does not modify run-scoped generated objects or unrelated resources.

## 11. Version And Snapshot Semantics

An object's source version remains content-addressed:

```text
<objectKey>@<sourceHashPrefix>
```

The batch `snapshotHash` is computed from a canonical sorted projection containing path, object key, kind, declared lifecycle status, source hash, and typed references. Timestamps and diagnostics are not part of the hash.

Repeated startup with identical inputs is idempotent:

- object versions do not change;
- no duplicate active edges are created;
- the same snapshot hash is reported;
- audit history may record an idempotent observation without creating a new logical version.

When files change, new Goals use the latest successful graph snapshot. Existing workflow runs continue using their run-scoped frozen Library snapshot and recorded version refs.

## 12. Readiness And API Behavior

Persist a singleton current readiness projection plus immutable snapshot resources in the existing runtime-resource model; no new table is required.

`GET /api/v2/runtime/health` adds:

```json
{
  "library": {
    "ready": true,
    "status": "ready_with_warnings",
    "snapshotHash": "...",
    "includedCount": 42,
    "excludedCount": 3,
    "warnings": []
  }
}
```

When no successful current snapshot exists, `/api/v2/run-goal` returns HTTP `503` with a structured error:

```json
{
  "ok": false,
  "error": "library_not_ready",
  "diagnostics": {
    "reason": "goal_design_skill_missing",
    "missingRefs": [],
    "sourcePaths": []
  }
}
```

The browser renders this as a Library readiness problem with an action to open the existing Library surface. It must not label the error as an LLM or generic Workflow generation failure.

## 13. Startup And Recovery

Reconcile runs after Postgres schema validation and before the runtime server writes its ready PID record or accepts HTTP traffic.

- success: runtime and web startup continue;
- ready with non-blocking exclusions: startup continues and health reports warnings;
- approved schema error or required-purpose failure: runtime startup fails with source-path diagnostics;
- database/write failure: startup fails and the prior snapshot remains intact;
- concurrent startup: the advisory lock serializes reconciliation and the second process observes the committed result;
- interrupted reconcile: transaction rollback prevents partial graph state.

`southstar:status` should distinguish `library_not_ready` startup failure from a generic stopped process when the startup log contains a reconcile result.

An operator recovery action may rerun the same reconcile service after fixing files. Restarting the complete stack is not logically required, though the initial implementation may expose it through `southstar:start` plus the existing Library sync API.

## 14. Library UI And Import Integration

The Library UI remains an authoring and inspection surface:

- `Save & Sync` writes the file, then invokes reconcile through the shared service;
- import approval writes approved local files, then invokes the same reconcile service;
- graph and object viewers show the current snapshot hash and whether a file is included, excluded, stale, deprecated, or blocked;
- startup reconcile does not create UI-only objects or bypass import approval;
- the Workflow browser never sends Goal Design skill ids or bodies.

Single-file sync may optimize discovery to an affected closure, but its resulting transaction and snapshot must be semantically equivalent to a full reconcile. A safe first implementation may always execute the full batch.

## 15. Security And Governance

- File metadata grants Library deployment approval, not tool execution authority.
- Existing tool/MCP/vault risk and approval policies remain enforced during composition and execution.
- Secrets are never read into sync snapshots, diagnostics, history, or health output.
- Source paths are relative to the configured Library root.
- Reconcile cannot expand an existing run's authority or mutate its frozen snapshot.
- Browser clients cannot cause arbitrary filesystem roots to be reconciled.
- No fallback silently substitutes an unrelated skill when the Goal Design purpose invariant fails.

## 16. Testing Strategy

### 16.1 Focused tests

- discovery accepts every supported file kind and is order-independent;
- an approved invalid file fails with its source path;
- duplicate object keys fail with both paths;
- closed-set resolution removes transitive broken references and reports all missing refs;
- no placeholder objects are produced;
- exactly zero, one, and multiple Goal Design purpose records produce the expected readiness result;
- changed content changes object version and batch snapshot hash;
- unchanged content is idempotent;
- removed file-backed objects become deprecated and their edges inactive;
- non-file-backed generated objects are untouched.

### 16.2 Real Postgres tests

- object-first/edge-second synchronization succeeds for arbitrary file order;
- a failing edge/reference write rolls back the whole batch;
- advisory locking serializes two concurrent reconciles;
- previous successful readiness remains authoritative after a failed reconcile;
- existing run snapshots retain prior versions after a later reconcile.

### 16.3 Lifecycle and API tests

- runtime does not listen or write a ready PID record before reconcile completes;
- startup fails clearly when the Goal Design purpose invariant fails;
- health reports ready, warning counts, and snapshot hash;
- `/run-goal` returns structured `503 library_not_ready` before readiness;
- `/run-goal` loads the graph-backed skill after readiness without receiving a browser skill id/body;
- Library UI, import approval, and startup use the same reconcile seam.

### 16.4 Browser E2E

Case 32 removes its test-only `syncBaseLibrary()` setup. It starts the managed product stack, observes Library readiness, submits a Goal through the existing Workflow input, reviews the Goal Contract and Slice Plan, confirms composition, runs the existing DAG, and verifies accepted outcome evidence.

The E2E asserts invariants rather than fixed content:

- one successful Library sync snapshot;
- exactly one resolved Goal Design purpose record;
- the Goal package records its object/version provenance;
- no browser request contains a skill body or concrete Goal Design id;
- no fixture composer, mock/fake runtime provider, seed, or fallback is used;
- screenshot and text snapshots capture each browser operation and resulting state.

## 17. Acceptance Criteria

- **AC-01 Startup readiness:** a clean managed startup reconciles approved Library files before accepting Goal traffic.
- **AC-02 No setup helper:** browser E2E succeeds without directly calling `syncLibraryFileToGraph()` or a test seed helper.
- **AC-03 Graph runtime truth:** Goal and Workflow APIs read the Postgres graph and never raw files during execution.
- **AC-04 Generic discovery:** no concrete Library object or domain id is embedded in discovery, closure, reconcile, or startup code.
- **AC-05 Purpose invariant:** exactly one included approved Goal Design purpose record is required without hardcoding its id.
- **AC-06 Atomicity:** any reconcile failure leaves the previous successful graph/readiness state unchanged.
- **AC-07 Idempotency:** unchanged inputs retain object versions and snapshot hash across restart.
- **AC-08 Lifecycle:** removed file-backed content is deprecated rather than deleted; unrelated generated content is preserved.
- **AC-09 Structured failure:** Library readiness errors are returned as `library_not_ready`, not generic workflow-generation failures.
- **AC-10 Shared semantics:** startup, Library UI sync, and import approval use one reconcile service.
- **AC-11 Frozen runs:** existing run Library snapshots remain unchanged after later file synchronization.
- **AC-12 No forbidden bootstrap:** production uses no seed, fixture, mock, fake, placeholder, hardcoded object list, or fallback composer.

## 18. Implementation Boundaries

Likely touched modules:

- `src/v2/design-library/files/library-file-store.ts` — batch parsing/projection reuse and transaction-safe object/edge ordering;
- a focused `src/v2/design-library/files/library-reconcile-service.ts` — discovery, closure, readiness, and reconcile orchestration;
- `src/v2/design-library/library-graph-store.ts` — narrowly scoped lifecycle/deprecation queries if absent;
- `src/v2/server/runtime-server-lifecycle.ts` — reconcile-before-listen startup wiring;
- `src/v2/server/routes.ts` or a focused readiness service — health/readiness projection;
- `src/v2/server/planner-routes.ts` — `/run-goal` readiness guard;
- `src/v2/server/library-routes.ts` and import approval — shared reconcile invocation;
- web workflow error normalization — Library readiness presentation;
- focused, Postgres, lifecycle, and browser E2E tests.

Large unrelated refactors, a new Library database, and a new UI layout are outside this change.
