# Southstar Architecture Cleanup Implementation Plan

**Goal:** Remove production fake/fixture behavior and silent fallback paths, make Library candidate exposure complete and capability-driven, then deepen the highest-risk runtime seams without changing the existing Goal→DAG→Run product flow.

**Architecture:** Keep the current v2 route, orchestration, Postgres, Tork, and web seams. Production code will consume approved Library graph data and configured runtime capabilities; test doubles will live only under tests. Missing contracts, candidates, or execution bindings will be persisted as blocking diagnostics instead of being synthesized. Large modules will be split behind their existing exported entry points after the P0 behavior is stabilized.

**Tech Stack:** TypeScript ESM, Node 22, Postgres, Vitest, Next.js web, codebase-memory graph.

## Global Constraints

- Production composer mode remains LLM-only; no fixture or fallback composer is added.
- No hardcoded domain, agent, skill, provider, model, MCP, image, or candidate-name selection in runtime orchestration.
- Approved Library graph edges and version refs remain the source of selectable primitives.
- Missing required data fails closed and is visible in persisted planner/runtime diagnostics.
- Existing public route and workflow manifest shapes remain compatible unless a validator change is required to remove a silent fallback.
- Test doubles may remain only in test-owned paths and must not be imported by `src/v2`.

---

### Task 1: Move fake providers out of production

**Files:**
- Delete: `src/v2/brain/fake-brain-provider.ts`
- Delete: `src/v2/hands/fake-hand-provider.ts`
- Create: `tests/support/fake-brain-provider.ts`
- Create: `tests/support/fake-hand-provider.ts`
- Modify: tests importing the deleted files, including `tests/v2/brain-provider.test.ts`, `tests/v2/postgres-recovery-controller.test.ts`

**Interfaces:**
- Consumes: existing `BrainProvider`, `HandProvider`, and their input/result types.
- Produces: test-only `createFakeBrainProvider` and `createFakeHandProvider` with the same signatures.

- [x] **Step 1: Add test-owned providers with the current behavior.**
- [x] **Step 2: Update every test import to `tests/support/*`.**
- [x] **Step 3: Delete the production files.**
- [x] **Step 4: Run `rg -n "fake-(brain|hand)-provider" src/v2` and expect no matches.**
- [x] **Step 5: Run focused brain/hand/recovery tests.**

### Task 2: Remove fixture terminology from the evolution runtime

**Files:**
- Modify: `src/v2/evolution/sandbox.ts:88-230`
- Modify: `tests/v2/evolution-sandbox.test.ts`

**Interfaces:**
- Consumes: existing sandbox experiment and workspace resource payloads.
- Produces: a persisted workspace isolation value that describes the actual provider behavior and is accepted by the manifest/runtime workspace policy.

- [x] **Step 1: Add a regression assertion that sandbox resources never contain `temp-fixture-copy`.**
- [x] **Step 2: Replace the label with the actual ephemeral workspace provider value and keep the path/provider metadata together.**
- [x] **Step 3: Materialize selected source-snapshot assets and fail closed when an asset cannot be materialized.**
- [x] **Step 4: Run the focused evolution sandbox tests.**

### Task 3: Make candidate exposure complete and requirement-closed

**Files:**
- Modify: `src/v2/orchestration/graph-metadata-packet.ts`
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/orchestration/candidate-resolver.ts` only if the packet needs explicit closure metadata.
- Test: `tests/v2/library-candidate-resolver.test.ts`, `tests/v2/library-constrained-regression.test.ts`

**Interfaces:**
- Consumes: approved graph objects, active edges, requirement capability/artifact refs.
- Produces: a candidate packet where pinned refs and their required edge closure are never dropped; optional ranking is budgeted by input metadata, not per-kind constants.

- [x] **Step 1: Add coverage for approved MCP grants and over-limit candidate packets.**
- [x] **Step 2: Remove `NODE_LIMITS` and the `mcp_tool_grant: 0` exclusion.**
- [x] **Step 3: Replace per-kind packet slices with deterministic host-selected budget trimming that preserves graph metadata and pinned refs.**
- [x] **Step 4: Include candidate counts and omitted optional refs in the prompt summary for diagnostics.**
- [x] **Step 5: Run candidate resolver and composer prompt tests.**

### Task 4: Replace generated profile static policy with runtime capability validation

**Files:**
- Modify: `src/v2/orchestration/generated-agent-profile-policy.ts`
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/server/runtime-context.ts` and lifecycle wiring only if provider capability data must be passed to composition validation.
- Test: `tests/v2/workflow-composer-registry.test.ts`, `tests/v2/workflow-composition-validator.test.ts`

**Interfaces:**
- Consumes: approved Library primitives and configured brain/hand/provider capabilities.
- Produces: host-safety validation without a hardcoded domain/provider/model/image allowlist.

- [x] **Step 1: Add tests for approved non-default primitives and unsupported host bindings.**
- [x] **Step 2: Remove static generated profile value arrays from the prompt contract.**
- [x] **Step 3: Validate shape, graph refs, configured host capability, command safety, and execution protocol.**
- [x] **Step 4: Keep unsupported bindings as blocking validation issues, never fallback to Pi/default values.**
- [x] **Step 5: Run focused composer and manifest validation tests.**

### Task 5: Fail closed on Goal Contract materialization

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts:1061-1100,1660-1707`
- Modify: `src/v2/orchestration/goal-contract.ts:363-367` if fallback artifact derivation still hides a missing contract field.
- Test: `tests/v2/postgres-run-api.test.ts`, planner draft tests.

**Interfaces:**
- Consumes: validated planner draft payloads and Goal Design package hashes.
- Produces: run materialization only from an explicit, validated Goal Contract; migration-only readers cannot create a new run.

- [x] **Step 1: Add a regression test proving a draft without `goalContract` cannot create a run by inventing requirements.**
- [x] **Step 2: Remove `fallbackRequirement` and block missing requirement/acceptance/artifact lineage.**
- [x] **Step 3: Convert template fallback from silent alternate composition to an explicit persisted blocking decision.**
- [x] **Step 4: Keep legacy decoding only for inspection/revision migration and make new run materialization non-runnable without an explicit contract.**
- [x] **Step 5: Run focused Postgres planner/run tests.**

### Task 6: Delete obsolete paths after caller proof

**Files:**
- Inspect and then remove: `src/v2/planner/pi-planner.ts` legacy canonicalizer path.
- Consolidate: `src/v2/orchestration/goal-design.ts` V1/V2 validators behind one canonical V2 path plus migration adapter.
- Remove obsolete fields/usages: `composerFallbackUsed` in manifest/planner trace if no production reader remains.
- Tests: static gate and production route trace tests.

**Interfaces:**
- Consumes: graph call-site evidence and persisted migration requirements.
- Produces: one canonical Goal Design package and one planner composition path.

- [x] **Step 1: Prove inbound production callers are absent with graph call-site tracing and route tests.**
- [x] **Step 2: Preserve and cover migration-only legacy inspection/revision adapters.**
- [x] **Step 3: Delete unreachable planner canonicalizer/revision-loop code and obsolete `composerFallbackUsed`.**
- [x] **Step 4: Run static gates and the complete v2 suite.**

### Task 7: Split large modules only after P0 behavior is green

**Files:**
- Split behind current exports: `src/v2/server/routes.ts`, `src/v2/server/planner-routes.ts`, `web/hooks/useAgentSession.ts`, `web/components/AppShell.tsx`, `src/v2/executor/postgres-tork-callback.ts`, `src/v2/exceptions/recovery-decision-applier.ts`.

**Interfaces:**
- Consumes: stabilized P0 behavior and existing route/runtime contracts.
- Produces: smaller modules with one responsibility while preserving current public entry points.

- [x] **Step 1: Use existing route/read-model/recovery/session characterization gates and add planner-input coverage.**
- [x] **Step 2: Extract route-family dispatch and planner input parsing behind the existing public entry points.**
- [x] **Step 3: Run focused tests after each extraction.**
- [x] **Step 4: Run the web build and complete v2 suite before declaring the split complete.**

## Completion notes

- Runtime fake providers now exist only under `tests/support/`; production adapter-boundary tests assert they are absent.
- Sandbox workspaces persist real ephemeral workspace metadata and materialize only approved source-snapshot assets.
- Candidate exposure is graph-complete by default; any input-size budget is explicit host configuration and reports omitted optional refs.
- Generated profile bindings are selected by the LLM and accepted only when the configured host advertises them; no provider/model/image fallback is used.
- New runs require an explicit validated Goal Contract and immutable Library/coverage lineage. Legacy decoding remains read/revision migration support only.
- Route dispatch and planner request parsing are separated without changing the runtime route/API entry points.
