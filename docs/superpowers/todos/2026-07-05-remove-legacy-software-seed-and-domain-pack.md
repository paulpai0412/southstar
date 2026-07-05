# Remove Legacy Software Seed And Domain Pack TODO

Goal: remove active runtime reliance on `software-library-seed.ts`, `softwareDomainPack`, and hardcoded `profile.software-*` / `skill.software-*` refs while keeping the graph-backed workflow and library runtime paths working.

## Current Scan

- `src/v2` files importing `softwareDomainPack` or `domain-packs/software`: 0
- `src/v2` files importing `software-library-seed` or `softwareVaultLeasePolicies`: 0
- active runtime files importing `workflow-generator/*`: 0
- test files importing `softwareDomainPack`: 0
- test files importing production `software-library-seed`: 0
- legacy files deleted from `src/v2`: `design-library/software-library-seed.ts`, `domain-packs/software.ts`, `domain-packs/registry.ts`, `workflow-generator/constrained-generator.ts`, `workflow-generator/materialize.ts`

## Principles

- Do not re-enable old stored `agent_profile` selection for workflow generation.
- Do not loosen graph-backed composition validation to make old refs pass.
- Preserve runtime execution for generated manifests that already include roles, agent profiles, policies, artifact contracts, and evaluator pipelines.
- Replace active UI/read-model data sources with Postgres graph or manifest data before deleting legacy files.
- Keep tests-only graph fixtures under `tests/v2/fixtures/`; production code must not import runtime seed files.

## TODO

- [x] **1. Remove old refs from production composer fixtures**
  - Target: `src/v2/orchestration/composer.ts`, `src/v2/orchestration/composer-registry.ts`, related tests.
  - Outcome: no production `DeterministicFixtureComposer` hardcodes `profile.software-*` / `skill.software-*` / `agent.software-*`.
  - Verification: composer registry, planner draft progress, composition compiler tests.
  - Completed 2026-07-05: removed production `DeterministicFixtureComposer`, kept deterministic composition in `tests/v2/fixtures/deterministic-workflow-composer.ts`, retired fixture/fallback registry expectations, and documented `composerMode: "llm"` as the only active runtime mode.

- [x] **2. Retire legacy ref compatibility from active runtime**
  - Target: `src/v2/orchestration/library-ref-compat.ts` call sites in context/task-envelope materialization.
  - Outcome: generated manifests must carry canonical graph refs directly; legacy `software.implementation` aliases are not silently mapped in active runtime.
  - Verification: runtime materializer and task envelope tests updated to canonical refs.
  - Completed 2026-07-05: deleted `library-ref-compat.ts` and removed alias mapping from context/task-envelope materialization.

- [x] **3. Replace Agent Library read model seed/domain-pack source**
  - Target: `src/v2/read-models/agent-library.ts`.
  - Outcome: read model derives roles/profiles/skills/tools/MCP/vault/policies from Postgres library graph or manifest/library file state, not `softwareDomainPack` or `softwareVaultLeasePolicies`.
  - Verification: agent-library read model tests.
  - Completed 2026-07-05: `agent-library.ts` now derives approved objects and edges from Postgres graph.

- [x] **4. Replace Workflow UI domain-pack summary/details**
  - Target: `src/v2/read-models/workflow-ui.ts`.
  - Outcome: workflow task details prefer manifest definitions and graph/library resources; no seed/domain-pack fallback in active UI read model.
  - Verification: workflow-ui read model tests.
  - Completed 2026-07-05: `workflow-ui.ts` now uses manifest definitions for task details and summary counts.

- [x] **5. Remove domain-pack fallback from context assembly**
  - Target: `src/v2/context/managed-context-assembler.ts`.
  - Outcome: context assembly requires manifest-embedded definitions or graph-backed runtime definitions; no implicit `softwareDomainPack`.
  - Verification: scheduler/context tests with generated graph-backed manifests.
  - Completed 2026-07-05: context assembly requires manifest-embedded roles, profiles, artifact contracts, evaluator pipelines, context policies, and memory policies.

- [x] **6. Remove domain-pack fallback from task envelope inspection**
  - Target: `src/v2/ui-api/postgres-task-envelope.ts`.
  - Outcome: task envelope inspection reconstructs from persisted envelope/context or manifest definitions only.
  - Verification: postgres task envelope tests.
  - Completed 2026-07-05: task envelope inspection rebuilds only from persisted envelope/context plus manifest definitions.

- [x] **7. Retire deterministic domain-pack planner path**
  - Target: `src/v2/ui-api/postgres-run-api.ts`, `src/v2/workflow-generator/*`, `src/v2/domain-packs/*`.
  - Outcome: default planner path is graph-backed composition; deterministic domain-pack path is removed or isolated as test-only outside active runtime.
  - Verification: postgres run API tests and runtime API alignment tests.
  - Completed 2026-07-05: default planner path is graph-backed LLM composition; deterministic domain-pack generator files were removed.

- [x] **8. Replace evolution sandbox domain-pack dependency**
  - Target: `src/v2/evolution/sandbox.ts`.
  - Outcome: sandbox uses manifest definitions or a graph-backed library snapshot.
  - Verification: evolution sandbox tests.
  - Completed 2026-07-05: sandbox uses manifest-only managed context assembly.

- [x] **9. Clean tests**
  - Target: tests importing `softwareDomainPack`, `seedSoftwareLibraryGraph`, or old refs.
  - Outcome: tests seed minimal graph primitives or use generated graph-backed fixtures.
  - Verification: focused v2 tests, then broad `npm run test:v2` when feasible.
  - Completed 2026-07-05: old domain-pack/generator tests were removed, tests now use local primitives or tests-only graph fixtures.

- [x] **10. Delete legacy files after all active references are gone**
  - Target: `src/v2/design-library/software-library-seed.ts`, `src/v2/domain-packs/software.ts`, `src/v2/domain-packs/registry.ts`, and eventually `src/v2/domain-packs/types.ts` if no longer needed.
  - Outcome: no active imports; docs updated to describe graph-backed library source of truth.
  - Verification: `rg "softwareDomainPack|software-library-seed|profile\\.software-|skill\\.software-|agent\\.software-" src/v2 tests/v2`.
  - Completed 2026-07-05: deleted legacy production files and updated AGENTS/README/spec notes.
