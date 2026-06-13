# Southstar v2 Phase 1.5 Coverage

Source spec: `docs/superpowers/specs/2026-06-12-southstar-v2-operations-ui-api-executor-design.zh.md`

| Requirement | Evidence | Implementation |
| --- | --- | --- |
| Built-in Southstar web app | `tests/web/southstar-operations-ui.test.tsx`, `npm run web:build`, browser screenshot | `app/**`, `components/southstar/**`, `lib/southstar/**` |
| Simple/Full mode | `visiblePanelsForMode` test, browser verification | `components/southstar/view-mode.ts`, `components/southstar/AppShell.tsx` |
| Voice transcript inside Planner Chat | source test and browser verification | `components/southstar/PlannerChat.tsx`, `src/v2/server/routes.ts` |
| Runtime server shared by UI/CLI/mobile | `tests/v2/server-api.test.ts` | `src/v2/server/**` |
| SSE + polling | `tests/v2/server-sse.test.ts` | `src/v2/server/sse.ts`, `src/v2/server/routes.ts` |
| ExecutorProvider with Tork provider | `tests/v2/executor-provider.test.ts` | `src/v2/executor/provider.ts`, `src/v2/executor/tork-provider.ts` |
| Approval policy | `tests/v2/approval-policy.test.ts`, `tests/v2/server-api.test.ts`, real E2E scenarios | `src/v2/approvals/**`, `src/v2/server/routes.ts` |
| Skill snapshots | `tests/v2/skills.test.ts`, real E2E scenarios | `src/v2/skills/**`, `src/v2/agent-runner/task-envelope.ts`, `src/v2/agent-runner/materializer.ts` |
| Complete CLI operation surface | `tests/v2/cli-operations.test.ts`, real E2E scenarios | `src/v2/cli.ts`, `src/v2/cli-client.ts`, `src/v2/cli-format.ts` |
| Quantitative gates | `tests/v2/phase15-gates.test.ts`, real E2E final gate | `src/v2/quality/phase15-gates.ts` |
| Real operation E2E | `npm run test:e2e:real` | `tests/e2e-real/scenarios/*` |
| Phase 1 regression retained | `npm run test:v2`, `npm test`, `npm run test:e2e:real` | existing v2 runtime |
