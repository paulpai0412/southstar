# Southstar Frontend UI Gap Closure TODO

Date: 2026-06-25
Status: in progress

## Source Documents

- `docs/superpowers/specs/2026-06-25-southstar-pi-web-ui-migration-design.md`
- `docs/superpowers/plans/2026-06-25-southstar-pi-web-ui-migration-implementation-plan.md`
- `docs/superpowers/specs/2026-06-25-southstar-dynamic-workflow-gap-closure-design.md`
- `docs/superpowers/plans/2026-06-25-southstar-dynamic-workflow-gap-closure-implementation-plan.md`

## Execution Rules

- Execute task by task.
- Use subagent-driven development for bounded implementation or review slices.
- Use TDD for every behavior change: write a failing test, verify red, implement, verify green.
- Do not hardcode workflow, role, model, skill, MCP, tool, vault, or run behavior that belongs in API contracts or read models.
- Do not replace real behavior with fake, mock, or smoke-only coverage.
- Run real browser UI E2E only after the functional tasks below are complete.

## Task 1 - Workflow Planner Input And Request Contract

Status: completed

Problem:

- Workflow left panel has only partial inputs.
- Client payload uses `plannerHints` and prompt fallback instead of the documented request contract.
- Design requires `goalPrompt`, `cwd`, `domainPackId`, `orchestrationMode`, `composerMode`, and structured `libraryHints` for roles, profiles, skills, MCP grants, tools, model hints, and vault/tool policy hints.

Acceptance:

- Workflow UI renders essential inputs by default and advanced structured hints in a collapsible section.
- `POST /api/v2/planner/drafts` receives the documented structured shape.
- Server accepts the structured shape without discarding compatible existing fields.
- Tests verify the request body and server route behavior with real code paths.

TDD entry points:

- `tests/web/southstar-workflow-canvas-ui.test.tsx`
- `tests/v2/postgres-run-api.test.ts`
- `lib/southstar/api-client.ts`
- `components/southstar/workflow/WorkflowWorkbench.tsx`
- `src/v2/server/routes.ts`

## Task 2 - Agent Library Panel Depth

Status: completed

Problem:

- Agent Library panel renders counts and selected refs, not the full capability surface.
- Design requires roles, profiles, skills, MCP, tools, artifact contracts, evaluator pipelines, vault/policy context, and selection alternatives.

Acceptance:

- Agent Library panel renders actual role/profile rows, skill/MCP/tool catalogs, artifact contracts, evaluator pipelines, and policy/context sections from read models.
- Selection alternatives remain prompt-review oriented and do not manually mutate workflow internals.
- Tests verify real read-model data is rendered through the component contract.

TDD entry points:

- `tests/web/southstar-workflow-canvas-ui.test.tsx`
- `tests/v2/agent-library-read-model.test.ts`
- `components/southstar/workflow/AgentLibraryPanel.tsx`
- `components/southstar/workflow/LibraryAlternativesSheet.tsx`
- `src/v2/read-models/agent-library.ts`

## Task 3 - Definition Inspector Depth And Revision Contract

Status: completed

Verification:

- TDD RED/GREEN completed in current worktree for inspector depth, read-model detail, planner trace, and repair detail.
- Focused verification passed: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`, `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx tsx tests/v2/workflow-ui-read-model.test.ts`, `npx tsc --noEmit --pretty false`.
- Spec compliance reviewer approved Task 3/4 after fixes.

Problem:

- Definition Inspector shows refs but not role definition detail, profile detail, vault policy, artifact contract detail, evaluator pipeline, or context policy.
- Revision prompt exists but must stay contract-aligned and show validation/repair/trace evidence.

Acceptance:

- Inspector renders selected task summary plus actual materialized role/profile/library refs.
- Inspector renders validation issues, repair attempts, planner trace refs, vault policy, artifact contract, evaluator pipeline, and context policy when present.
- Revision action calls the documented revise endpoint and preserves prompt-based editing only.

TDD entry points:

- `tests/web/southstar-workflow-canvas-ui.test.tsx`
- `tests/v2/workflow-ui-read-model.test.ts`
- `components/southstar/workflow/DefinitionInspector.tsx`
- `src/v2/read-models/workflow-ui.ts`

## Task 4 - Workflow Canvas Contract And Runtime Overlays

Status: completed

Verification:

- TDD RED/GREEN completed in current worktree for shared canvas contract, runtime overlays, edge statuses, and draft node badges/statuses.
- Focused verification passed: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`, `npx tsx tests/web/southstar-operator-ui.test.tsx`, `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx tsx tests/v2/workflow-ui-read-model.test.ts`, `npx tsc --noEmit --pretty false`.
- Browser-rendered pan/zoom/minimap usability remains assigned to Task 7 real browser UI E2E.

Problem:

- Frontend `WorkflowCanvasModel` omits `graphId`, `mode`, `selectedNodeId`, structured attention, and canonical edge fields.
- Operator runtime canvas strips badges and lacks runtime overlays for artifacts, executor, approvals, recovery, exceptions, dependency readiness, and active path.

Acceptance:

- Shared canvas contract matches the design contract while preserving compatibility boundaries for existing read models.
- Draft canvas shows full workflow arrows, statuses, badges, selection, fit view, pan, zoom, and minimap.
- Runtime canvas uses the same component in runtime mode and shows runtime overlays from read models.
- Edge statuses support pending, ready, active, blocked, and satisfied.

TDD entry points:

- `tests/web/southstar-workflow-canvas-ui.test.tsx`
- `tests/v2/workflow-ui-read-model.test.ts`
- `tests/v2/operator-overview-read-model.test.ts`
- `components/southstar/workflow-canvas/*`
- `components/southstar/operator/OperatorBoard.tsx`
- `src/v2/read-models/workflow-ui.ts`

## Task 5 - Operator Selection, Attention, Intervention, And Error Handling

Status: completed

Verification:

- TDD RED/GREEN completed in current worktree for operator attention taxonomy, contextual intervention modes, approved recovery apply affordance, command result display, unique runtime command ids, and generic SSE reconnect cursor handling.
- Focused verification passed: `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx tsx tests/v2/operator-overview-read-model.test.ts`, `npx tsx tests/web/southstar-operator-ui.test.tsx`, `npx tsc --noEmit --pretty false`.
- Spec compliance reviewer approved after fixes for `serverBaseUrl` SSE wiring, arbitrary named SSE frames, per-run cursor scoping, and approved recovery decisions.
- Code quality reviewer approved after fixes for unique command IDs and removal of inert GET commands.

Problem:

- Workflow run handoff does not force-select the newly created run in Operator.
- Attention queue does not cover all required item classes.
- Intervention Panel lacks contextual modes and command result/pending/stale state.
- Error handling is partial.

Acceptance:

- `Run Workflow` opens Operator with the new run selected.
- Attention item click selects run, focuses DAG node, and opens the correct intervention mode.
- Operator overview includes runtime exceptions, approvals, recovery decisions, stale executor heartbeat, queue timeout, callback missing, blocked dependency, failed task, paused run, and normal active run watch items when real read-model state supports them.
- Intervention Panel renders run/task/exception/executor/approval/recovery detail modes, API affordance commands, reason-required risky commands, pending command status, rejected command result, and disabled reasons.
- SSE disconnect keeps last snapshot and reconnects with cursor semantics.

TDD entry points:

- `tests/web/southstar-operator-ui.test.tsx`
- `tests/v2/operator-overview-read-model.test.ts`
- `components/southstar/app/SouthstarPiWebShell.tsx`
- `components/southstar/operator/*`
- `src/v2/read-models/operator-overview.ts`

## Task 6 - Chat Native Pi-Web Parity

Status: completed

Verification:

- TDD RED/GREEN completed in current worktree for native freeform chat send, chat capabilities, read-model-backed branch lineage, selected-branch parent send contract, optimistic echo reconciliation, and unsupported attachment gating.
- Focused verification passed: `npx tsx tests/web/southstar-pi-web-shell-ui.test.tsx`, `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx tsx tests/v2/chat-capabilities-read-model.test.ts`, `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx tsx tests/v2/chat-session-routes.test.ts`, `npx tsc --noEmit --pretty false`.
- Spec compliance reviewer approved after fixes for normal send not using `api.steer`, runtime steering separation, and read-model branch lineage.
- Code quality reviewer approved after fixes for selected branch parent contract, optimistic local echo reconciliation, and disabled unsupported attachment UI.

Problem:

- Chat tab is a Southstar runtime transcript surface, not full pi-web native chat.
- Missing model controls, skill controls, branch/minimap navigation, and native chat input behavior.

Acceptance:

- Chat tab preserves pi-web shell style and imports or faithfully ports the native chat workspace behavior.
- Runtime transcript remains available without taking over freeform chat responsibility.
- Session sidebar and file viewer remain connected to Southstar APIs.
- Model and skill controls are visible and data-driven where API data exists.

TDD entry points:

- `tests/web/southstar-pi-web-shell-ui.test.tsx`
- `components/southstar/chat/*`
- `components/southstar/app/SouthstarPiWebShell.tsx`

## Task 7 - Real Browser UI E2E

Status: pending

Problem:

- Current `tests/web/*` are mostly source assertions and do not prove browser-rendered behavior.

Acceptance:

- Add real browser UI E2E that starts the web app and verifies:
  - app opens with `Chat | Workflow | Operator` tabs in pi-web visual style
  - Chat shows session sidebar, chat panel, and file viewer behavior
  - Workflow generates a draft and renders the full DAG canvas with arrows
  - selecting a DAG node opens Definition Inspector with role/profile/skills/tools
  - running a draft opens Operator with the selected run
  - Operator shows active runs and attention queue
  - selecting an attention item focuses the DAG node and opens Intervention Panel
  - canvas fit-view, pan, zoom, minimap, and selection are usable on desktop and mobile widths
- Browser E2E uses real server/API paths available in the repo test harness, not source-only tests.

TDD entry points:

- new browser E2E test file under an appropriate `tests/` path
- `package.json`
- existing Postgres/server harness utilities
- Playwright or repo-approved browser runner

## Task 8 - Coverage Document Refresh

Status: completed

Verification:

- `docs/superpowers/productized-ui-library-planner-coverage.md` now reflects `Chat | Workflow | Operator`, migrated shell file ownership, workflow/operator/chat read-model and route ownership, and current test evidence.
- Coverage explicitly marks Task 7 real browser E2E as pending and does not claim full completion while browser E2E remains failing.

Problem:

- Existing coverage document still references `Operations`, old app-shell paths, and stale E2E paths.

Acceptance:

- Coverage document reflects `Chat | Workflow | Operator`, pi-web shell migration, current route/read-model files, and real browser E2E evidence.
- It does not claim full completion until verification evidence exists.

TDD entry points:

- `docs/superpowers/productized-ui-library-planner-coverage.md`
- this TODO document
