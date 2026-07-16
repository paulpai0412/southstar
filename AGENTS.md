# AGENTS.md

This file is the working contract for agents modifying Southstar.

## Product and source of truth

Southstar (`@southstar/runtime`) is a Postgres-backed, workflow-driven runtime for long-running multi-agent work. It plans goals, composes validated DAG manifests from the Library, schedules tasks, executes through Tork/Pi, persists sessions and artifacts, evaluates outcomes, and exposes operator read models.

The active implementation is `src/v2/` plus the Next.js app in `web/`. Older Northstar, SQLite, root-Next, and issue-to-PR documents are historical unless current code/tests explicitly use them.

## Non-negotiable engineering rules

- Use the repository's current architecture and public API seams; do not create a parallel workflow/UI/runtime model for a local feature.
- Production composition is `composerMode: "llm"` and approved Library graph data only. Never add fixture composers, production fake providers, or `llm-with-fixture-fallback`.
- Do not hardcode domain, agent, skill, tool, MCP, provider, model, image, or candidate-name selection. Runtime capability checks may reject unsupported bindings; they must not substitute defaults.
- Remove silent or masking fallbacks, invented requirements, invented artifacts, and automatic alternate template selection. Missing required data fails closed with a persisted, diagnosable blocking result.
- Test doubles belong only in test-owned paths. They must not replace real integration behavior or be presented as E2E evidence.
- Keep route handlers thin. Put business rules in orchestration, scheduler, executor, stores, exceptions, context, memory, or UI read-model modules.
- External effects must be persisted as history/resources/snapshots before downstream code assumes them. Never put secrets in prompts, logs, history, ordinary resources, or inspect output.
- Represent runtime commands as argv arrays. Avoid shell command chaining except in existing lifecycle launchers.

## Runtime and commands

- Node `>=22.22.2`, ESM, TypeScript executed with `tsx`; runtime has no compiled `dist/` requirement.
- Persistence is Postgres under schema `southstar`; SQLite is legacy/test-only unless a file says otherwise.
- Active UI is `web/`; do not start/debug the retired root Next app.

```bash
npm install
npm test
npm run test:v2
npm run test:postgres
npm run southstar:start
npm run southstar:status
npm run southstar:stop
npm run southstar -- db:init --database-url postgres://postgres:postgres@127.0.0.1:55432/southstar
npm run southstar -- run-goal --goal "..."
npm --prefix web install
npm --prefix web run dev
npm --prefix web run build
```

`npm run southstar:start` manages Postgres (`127.0.0.1:55432`), Tork (`8000`), Tork admin (`8100`), runtime API (`3100`), and web UI (`30141`). Use `SOUTHSTAR_PI_PLANNER_TIMEOUT_MS` for long Pi composition. The web lifecycle prefers `SOUTHSTAR_WEB_APP_DIR`, then `~/apps/southstar/web`, then `./web`.

Do not run `test:e2e:*`, `test:live`, or host/GitHub/Tork live scripts unless the task explicitly requests real infrastructure and credentials.

## Code discovery

When codebase-memory-mcp is available, index the repository first if needed, then prefer:

1. `search_graph` / `search_code`
2. `trace_path`
3. `get_code_snippet`
4. `query_graph` / `get_architecture`

Use `rg` for literals, configs, scripts, and non-code files when graph tools are unavailable or insufficient.

## Architecture map

- `src/v2/cli.ts`: CLI and `serve` entry point.
- `src/v2/server/`: HTTP server, route families, lifecycle managers, runtime loops, SSE/live events.
- `src/v2/db/`: Postgres schema and initialization.
- `src/v2/stores/`: workflow runs/tasks/history/resources and library persistence.
- `src/v2/orchestration/`: requirement analysis, candidate resolution, LLM composition, validation/repair, compilation, Goal Design/Contract.
- `src/v2/design-library/`: approved Library objects, graph edges, templates, profiles, validators, and import/sync services.
- `src/v2/manifests/`: canonical `SouthstarWorkflowManifest` types and validation.
- `src/v2/scheduler/`: runnable-task claiming, dependency checks, parallelism, context/checkpoints, and dispatch.
- `src/v2/executor/` and `src/v2/hands/`: Tork provider, bindings, callbacks, reconciliation, and hand adapters.
- `src/v2/session/`, `context/`, `memory/`: durable session truth, task envelopes/context projections, and memory resources.
- `src/v2/exceptions/`: runtime exceptions, recovery decisions, approvals, and operator actions.
- `src/v2/read-models/` and `src/v2/ui-api/`: browser/operator projections; browsers must not reconstruct truth from raw tables.
- `web/app/`, `web/components/`, `web/lib/`: active Next.js UI and runtime API proxies.

## Goal to DAG to run

1. Browser workflow APIs under `web/app/api/workflow/*` call runtime routes through `web/lib/workflow/v2-api.ts`.
2. Planner/orchestration derives a validated Goal Contract and requirement list. A new run requires an explicit contract, requirement acceptance criteria, artifact lineage, and immutable Library/coverage refs.
3. Candidate resolution reads approved Library graph objects/edges/version refs. Goal domain must not exclude legitimate cross-scope objects.
4. `llm-composer.ts` proposes slices/tasks/profiles from the candidate packet. LLM output is schema-checked; host runtime capabilities validate provider/model/harness/image/engine compatibility.
5. `composition-validator.ts`, repair loop, `composition-compiler.ts`, and `manifests/validate.ts` produce a canonical manifest. Missing data blocks; it is not synthesized.
6. Planner drafts persist in `runtime_resources`; `createPostgresRunFromDraft` materializes only an explicit validated Goal Contract into `workflow_runs` and `workflow_tasks`.
7. Preferred template incompatibility becomes a persisted blocking selection decision; never silently switch templates.

The Library authoring flow is:

```text
local library file -> parse -> validate -> sync -> approved graph
library import -> review/approve -> file write -> graph sync
goal contract -> requirement/slice coverage -> candidate packet -> LLM composition
validated composition -> canonical manifest -> planner draft -> workflow run
```

Agents/skills are Markdown with YAML frontmatter. Tools, MCP grants, generated profiles, and workflow templates are YAML. Generated DAG tasks carry typed `nodePromptSpec` with node type, requirements, boundaries, deliverables, outputs, tests, acceptance criteria, and type-specific checks.

## Runtime execution flow

```text
scheduler -> hand provider -> Tork job -> southstar-agent-runner
  -> /api/v2/executor/heartbeat
  -> /api/v2/tork/callback
  -> callback persistence/reconciliation/evaluation
```

The scheduler loads the manifest, skips non-pending tasks, checks dependency artifacts, claims runnable tasks within manifest parallelism, builds managed context, creates session checkpoints, persists brain/hand bindings, enforces tool policy, and submits through the configured hand. Brain decides intent; hand provisions execution.

Callbacks append history, update run/task snapshots, write resources/artifacts, terminalize bindings, and trigger completion/recovery gates. Accepted task artifacts are `artifact_ref` resources backed by `artifact_blobs`; downstream tasks receive accepted upstream content through managed context `priorArtifacts`.

## Persistence invariants

- `workflow_history` is append-only audit truth.
- `workflow_runs.workflow_manifest_json` is the current canonical manifest.
- `workflow_tasks` is a per-task snapshot; DAGs may run tasks in parallel, so do not rely on one global current task.
- `runtime_resources` stores planner drafts, context packets, task envelopes, bindings, approvals, recovery decisions, memory, and artifact references.
- Run cleanup should delete by `workflow_runs.id`; cascades remove tasks/history/artifact blobs, while run-scoped resources and learning nodes need explicit cleanup where applicable.
- Read-model conflicts with history/snapshots are projection bugs to investigate, not reasons to rewrite lifecycle truth.

## Recovery and operator behavior

Use runtime command routes for pause/resume/cancel/retry/fork/reset/rollback/revision and recovery approval. Do not mutate Postgres directly from operator UI. A failed worktree merge or external effect must become an operator-visible blocking/recovery state; it must not loop indefinitely without a configured retry limit.

## Verification and user preferences

- Before continuing, inspect relevant session/conversation records, rollout summaries, existing plans, git state, and current code. Resume unfinished work instead of restarting.
- Diagnose from logs, DB state, routes, processes, browser output, and git topology before changing code. Verify the original failure point after a fix.
- For real E2E requests, use real browser/API/Postgres/Tork/Pi/runtime integrations and verify Goal → Requirement → Slice → DAG → Executor → Evaluator with DB/history/resource/artifact/session/callback evidence. Smoke, mock, fixture, static-file, or token checks are not E2E evidence.
- During long tests/E2E, report phase, checkpoint, elapsed time, and blockers about every three minutes when practical; confirm a job is active before calling it stuck.
- Before claiming completion, run appropriate TypeScript/build checks, focused tests, the full relevant suite, `git diff --check`, and explicitly requested real E2E.
- Let LLMs handle semantic decomposition, ranking, slices, and prompt content; keep schema, state, permissions, retries, persistence, dependency, and safety controls deterministic.
- Reuse existing workflow layout, routes, read models, contracts, and Library graph. Do not over-design or build a second UI for a local change.
- Only commit/merge/push/sync when requested. When requested, verify actual local/remote topology and report the result.

## Optional skill hints

- `ponytail@ponytail` is installed/enabled. For coding, refactoring, or review tasks, use the bundled `ponytail` skill by default (`lite`, `full`, or `ultra`); use `ponytail-review`/`ponytail-audit` for explicit review/audit requests. Read the installed `SKILL.md` first, reuse existing code, apply YAGNI/stdlib/native-first, and never simplify away validation, security, accessibility, error handling, or explicitly requested real E2E.
- `karpathy-guidelines` is installed at `~/.codex/skills/karpathy-guidelines`. For prompt/agent-quality, simplicity, or surgical refactor work, read its `SKILL.md` and apply its think-before-coding, minimum-change, and verifiable-success guidance; also recognize the possible user spelling `kathpathy`.

## Testing guidance

- Use focused tests for a subsystem and `npm run test:v2` for the v2 gate.
- Use `npm --prefix web run build` for web routing/import/UI changes.
- Use real infrastructure tests only when explicitly requested; otherwise prefer deterministic tests with test-owned doubles and explicit graph primitives.
