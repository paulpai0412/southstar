# Southstar Productized UI + Library-aware Planner Coverage

Source specs:
- `docs/superpowers/specs/2026-06-16-southstar-productized-ui-library-aware-planner-design.zh.md`
- `docs/superpowers/specs/2026-06-25-southstar-pi-web-ui-migration-design.md`
- `docs/superpowers/specs/2026-06-25-southstar-dynamic-workflow-gap-closure-design.md`

Status date: 2026-06-26
Overall status: in progress (Task 7 real browser E2E is still open)

| Requirement | Status | Evidence | Implementation |
| --- | --- | --- | --- |
| Southstar app shell migrated to `Chat \| Workflow \| Operator` using pi-web style | done | `npm test -- tests/web/southstar-pi-web-shell-ui.test.tsx`; `npm test -- tests/web/southstar-productized-app-shell-ui.test.tsx` | `app/page.tsx`, `app/chat/page.tsx`, `app/workflow/page.tsx`, `app/operations/page.tsx`, `components/southstar/app/SouthstarPiWebShell.tsx`, `components/southstar/workspace/WorkspaceTabs.tsx` |
| Workflow planner input contract (`goalPrompt`, `cwd`, `domainPackId`, orchestration/composer, structured `libraryHints`) | done | `npm test -- tests/web/southstar-workflow-canvas-ui.test.tsx`; `tests/v2/postgres-run-api.test.ts` | `components/southstar/workflow/WorkflowWorkbench.tsx`, `lib/southstar/api-client.ts`, `src/v2/server/routes.ts`, `src/v2/ui-api/postgres-run-api.ts` |
| Agent Library panel depth (roles/profiles/skills/MCP/tools/contracts/evaluators/policy/context) | done | `npm test -- tests/web/southstar-workflow-canvas-ui.test.tsx`; `tests/v2/agent-library-read-model.test.ts`; `tests/v2/agent-library-static-read-model.test.ts` | `components/southstar/workflow/AgentLibraryPanel.tsx`, `components/southstar/workflow/LibraryAlternativesSheet.tsx`, `src/v2/read-models/agent-library.ts`, `src/v2/server/routes.ts` |
| Definition Inspector depth + revise prompt flow | done | `npm test -- tests/web/southstar-workflow-canvas-ui.test.tsx`; `tests/v2/workflow-ui-read-model.test.ts` | `components/southstar/workflow/DefinitionInspector.tsx`, `components/southstar/workflow/WorkflowWorkbench.tsx`, `src/v2/read-models/workflow-ui.ts`, `src/v2/server/routes.ts` |
| Shared DAG canvas contract and runtime overlays (`@xyflow/react` + `elkjs`) | done | `npm test -- tests/web/southstar-workflow-canvas-ui.test.tsx`; `npm test -- tests/web/southstar-operator-ui.test.tsx`; `npx tsc --noEmit --pretty false` | `components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx`, `components/southstar/workflow-canvas/WorkflowTaskNode.tsx`, `components/southstar/workflow-canvas/WorkflowDependencyEdge.tsx`, `components/southstar/workflow-canvas/layout.ts`, `components/southstar/workflow-canvas/colors.ts`, `components/southstar/workflow-canvas/types.ts` |
| Operator run selection, attention queue, intervention modes, command result handling, SSE reconnect cursor semantics | done | `npm test -- tests/web/southstar-operator-ui.test.tsx`; `tests/v2/operator-overview-read-model.test.ts` | `components/southstar/operator/OperatorBoard.tsx`, `components/southstar/operator/AttentionQueue.tsx`, `components/southstar/operator/InterventionPanel.tsx`, `components/southstar/operator/RunEventStreamPanel.tsx`, `src/v2/read-models/operator-overview.ts`, `src/v2/server/ui-routes.ts` |
| Chat tab native pi-web parity (freeform chat + branch/minimap/input controls, runtime transcript separated) | done | `npm test -- tests/web/southstar-pi-web-shell-ui.test.tsx`; `tests/v2/chat-capabilities-read-model.test.ts`; `tests/v2/chat-session-routes.test.ts` | `components/southstar/chat/SouthstarNativeChatWorkspace.tsx`, `components/southstar/chat/SouthstarChatInput.tsx`, `components/southstar/chat/SouthstarBranchNavigator.tsx`, `components/southstar/chat/SouthstarChatMinimap.tsx`, `src/v2/read-models/chat-capabilities.ts`, `src/v2/read-models/chat-session.ts`, `src/v2/server/chat-routes.ts` |
| UI route/read-model completeness for workflow/operator compatibility aliases | done | `tests/v2/workflow-ui-read-model.test.ts`; `tests/v2/operator-overview-read-model.test.ts` | `src/v2/server/ui-routes.ts`, `src/v2/read-models/workflow-ui.ts`, `src/v2/read-models/operator-overview.ts` |
| Real browser UI E2E for Chat/Workflow/Operator and interactive DAG usability | pending | `tests/e2e-browser/07-real-ui-postgres-browser.test.ts` currently fails at planner draft response wait (`waitForResponse` timeout in `verifyWorkflowDraftAndRun`) | `tests/e2e-browser/browser-e2e-static.test.ts`, `tests/e2e-browser/07-real-ui-postgres-browser.test.ts`, `package.json` (`test:e2e:browser:07`) |

## Notes

- This document is synchronized to `Chat | Workflow | Operator` terminology and current file ownership.
- Full completion must not be claimed until Task 7 real browser E2E passes with fresh evidence.
