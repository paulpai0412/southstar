# Southstar Productized UI + Library-aware Planner Coverage

Source spec: `docs/superpowers/specs/2026-06-16-southstar-productized-ui-library-aware-planner-design.zh.md`

| Requirement | Evidence | Implementation |
| --- | --- | --- |
| Southstar App Shell with Chat / Workflow / Operations | `tests/web/southstar-productized-app-shell-ui.test.tsx`, `npm run web:build` | `app/page.tsx`, `app/chat/page.tsx`, `app/workflow/page.tsx`, `app/operations/page.tsx`, `components/southstar/app-shell/*`, `components/southstar/chat/*`, `components/southstar/workflow/*`, `components/southstar/operations/*` |
| Library-aware Planner core | `tests/v2/library-aware-planner.test.ts`, `tests/v2/productized-planner-draft.test.ts` | `src/v2/planner/library-aware-planner.ts`, `src/v2/ui-api/local-api.ts` |
| Planner result validation | `tests/v2/library-aware-planner-validator.test.ts` | `src/v2/planner/library-aware-validator.ts`, `src/v2/planner/library-aware-types.ts` |
| Software Engineering Starter Library v1 | `tests/v2/software-engineering-starter-library.test.ts` | `src/v2/design-library/software-engineering-starter.ts` |
| Coding reviewer / spec alignment / browser QA | planner and starter library tests | starter library seed, planner task generation |
| Release operator consolidation | starter library tests | `software.release-operator` profiles and skills |
| Task-level parallelism | planner tests and quantitative gates | planner DAG tasks and `dependsOn` edges |
| Context Economy | `tests/v2/context-economy.test.ts`, quantitative gates | `src/v2/context/economy.ts`, `src/v2/context/builder.ts`, `src/v2/ui-api/local-api.ts` |
| Fixed runner image + task-delivered skills/MCP | planner validator and quantitative gates | `src/v2/planner/library-aware-validator.ts`, `src/v2/ui-api/local-api.ts`, `src/v2/quality/productized-ui-library-planner-gates.ts` |
| Floating Operator | read model and web tests | `src/v2/ui-api/page-models/operator-attention.ts`, `components/southstar/operator/OperatorDock.tsx`, `components/southstar/operator/OperatorSheet.tsx` |
| Library alternatives side sheet | read model and web tests | `src/v2/ui-api/page-models/library-alternatives.ts`, `components/southstar/workflow/LibraryAlternativesSheet.tsx` |
| Non-calc E2E scenarios | `tests/e2e-real/index.test.ts` contract coverage; `npm run test:e2e:real` in live env | `tests/e2e-real/scenarios/todo-web-feature.ts`, `tests/e2e-real/scenarios/markdown-table-bugfix.ts`, `tests/e2e-real/scenarios/docs-cli-usage.ts`, `tests/e2e-real/scenarios/refactor-safety-net.ts` |
| Quantitative gates | `tests/v2/productized-ui-library-planner-gates.test.ts` | `src/v2/quality/productized-ui-library-planner-gates.ts` |
