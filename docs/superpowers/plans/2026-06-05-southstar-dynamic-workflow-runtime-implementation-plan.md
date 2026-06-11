# Southstar Dynamic Workflow Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Southstar generic multi-agent workflow runtime described by `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md`, covering local work creation, domain packs, agent catalogs, workflow DAG execution, artifact-governed policy evaluation, race/idempotency controls, CLI operations, the workflow authoring skill, the software-delivery pack, and an integrated Southstar web board migrated from the relevant `~/apps/pi-web` board code.

**Architecture:** Treat this checkout as a Northstar-derived code source but implement Southstar as a clean generic runtime. Replace issue-centric runtime concepts with `work_item`, `stage`, `task`, `artifact`, `policy`, `session`, `source`, and `projection`; keep source/projection and software-delivery concepts outside core behind pack/adapters. The core decision path is store transaction -> evaluator -> scheduler -> queued task rows -> dispatcher -> adapter facts; only the evaluator mutates work item runtime/workflow state.

**Tech Stack:** Node `>=22.22.2`, ESM TypeScript executed through `tsx`/Node type stripping, `node:test`, `node:assert/strict`, `node:sqlite`, YAML config/workflow/pack fixtures, deterministic fake host/source/projection adapters for default tests, Next 16 + React 19 for the integrated web board, optional Codex/OpenCode/Pi SDK adapters outside the offline gate.

---

## Source Spec

- `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md`
- Date: 2026-06-05
- Scope: Southstar generic multi-agent workflow runtime, not a Northstar migration branch.

## Current Baseline

The repository currently still contains Northstar-shaped runtime code:

- `package.json` package/bin/scripts are `@northstar/runtime`, `northstar`.
- `src/types/control-plane.ts` defines `IssueSnapshot`, Northstar lifecycle states, owner leases, and child runs.
- `src/runtime/store.ts` persists `issues` and `issue_history`, not Southstar's three-table schema.
- `src/types/workflow.ts` validates role-per-stage workflow YAML, not dynamic stage/task graphs.
- `src/cli/northstar.ts` and `src/cli/entrypoint.ts` expose Northstar commands.
- Existing tests use `node:test`, `node:assert/strict`, and `tsx`; keep that test style.

This plan intentionally separates Southstar identity/config work from core runtime replacement. Do not try to preserve Northstar v1 runtime compatibility in Southstar core.

## External UI Source To Integrate

The Southstar web board must be integrated from the relevant `~/apps/pi-web` add-on code, then renamed and adapted to Southstar contracts:

- Source UI components:
  - `/home/timmypai/apps/pi-web/components/northstar/NorthstarBoard.tsx`
  - `/home/timmypai/apps/pi-web/components/northstar/IssueDrawer.tsx`
  - `/home/timmypai/apps/pi-web/components/northstar/IssueSseModal.tsx`
  - `/home/timmypai/apps/pi-web/components/northstar/WatchSsePanel.tsx`
  - `/home/timmypai/apps/pi-web/components/northstar/WorkspaceTabs.tsx`
  - `/home/timmypai/apps/pi-web/components/northstar/workspace-views.tsx`
  - `/home/timmypai/apps/pi-web/components/northstar/useIssueStream.ts`
  - `/home/timmypai/apps/pi-web/components/northstar/usePiSessionSse.ts`
- Source API/client references:
  - `/home/timmypai/apps/pi-web/lib/northstar/types.ts`
  - `/home/timmypai/apps/pi-web/lib/northstar/server-client.ts`
  - `/home/timmypai/apps/pi-web/lib/northstar/local-api-loader.js`
  - `/home/timmypai/apps/pi-web/app/api/northstar/**`
- Source integration notes:
  - `/home/timmypai/apps/pi-web/docs/northstar-integration.md`
  - `/home/timmypai/apps/pi-web/docs/superpowers/specs/2026-06-03-northstar-board-only-design.md`
  - `/home/timmypai/apps/pi-web/docs/superpowers/specs/2026-06-03-northstar-board-enhanced-design.md`
  - `/home/timmypai/apps/pi-web/docs/superpowers/specs/2026-06-03-northstar-board-watch-and-sse-design.md`

Integration rule: copy/adapt the board into this repository; do not leave Southstar dependent on `~/apps/pi-web`, `@agegr/pi-web`, or a hard-coded `../../../northstar` source path. Southstar web routes must import Southstar's in-repo config, store, and read model directly.

## Execution Rules

- Use TDD for every behavior: write the failing test, run the focused test, implement the smallest code, run the focused test, then run `npm test` at phase gates.
- Keep all routine tests offline: no GitHub token, network, Codex SDK, OpenCode SDK, or Pi SDK required for `npm test`.
- Keep external commands represented as argv arrays. Do not add shell-chain strings using `&&`, `||`, or `;`.
- Runtime modules may read only `SOUTHSTAR_CONFIG`, `SOUTHSTAR_PROJECT_ROOT`, and `SOUTHSTAR_DEBUG` directly from `process.env`.
- Use `node:sqlite` through a store boundary only. Evaluator, scheduler, workflow validation, artifact validation, and policy evaluation stay pure.
- Store all runtime truth in `work_items`, `work_item_tasks`, and `work_item_history`.
- Do not add Northstar-specific terms to Southstar core files. Software delivery terms belong in `packs/software_delivery/`, source/projection adapters, or tests for that pack.
- Keep `npm test` as the final offline gate. Live tests, when added, must require explicit environment flags and must be skipped by default.
- This checkout did not return a usable `git status` during planning. Execution agents should still include commit checkpoints, but must first verify whether the execution workspace has valid git metadata.

## Phase Gates

| Phase | Outcome | Required Gate |
| --- | --- | --- |
| Phase 0 | Southstar identity, config, CLI shell, and legacy guardrails | `npm test` |
| Phase 1 | Three-table store, work item creation, pack/catalog/workflow resolution | `npm test` |
| Phase 2 | Evaluator, scheduler, artifacts, policy, and race/idempotency | `npm test` |
| Phase 3 | Dispatcher, host callbacks, projection worker, inspect/watch/simulate CLI | `npm test` |
| Phase 4 | Software-delivery pack and starter pack manifests | `npm test` |
| Phase 5 | Workflow authoring skill | `npm test` plus focused skill tests |
| Phase 6 | Integrated Southstar web board migrated from `~/apps/pi-web` | `npm test`, `npm run web:build`, browser smoke |
| Phase 7 | Final acceptance matrix and full verification | `npm test`, CLI smoke, web smoke, source scans |

## Acceptance Criteria Map

| AC | Requirement | Primary Tasks |
| --- | --- | --- |
| AC-01 | Create local SQLite work item with no external credentials | Tasks 4, 6, 16 |
| AC-02 | Lint/explain domain pack manifest, workflows, agents, prompts, schemas, mappings, fixtures, dashboard views | Tasks 7, 9, 20, 22 |
| AC-03 | Resolve `.southstar/agents.yaml`, pack assets, and workflow YAML into immutable snapshot | Tasks 7, 8, 10 |
| AC-04 | Workflow state maps to fixed runtime status | Tasks 5, 10, 13 |
| AC-05 | Stage starts root session in `work_item_tasks.kind=stage_root` | Tasks 12, 17 |
| AC-06 | Task starts child/subagent row with session ids | Tasks 12, 17 |
| AC-07 | Task artifact stored on task row with `artifact_kind` and `artifact_status` | Tasks 8, 13 |
| AC-08 | Artifact validates before policies can use it | Tasks 8, 13 |
| AC-09 | Rejected artifacts audited but cannot advance runtime | Tasks 8, 13 |
| AC-10 | Evaluator/scheduler/dispatcher/host/projection/dashboard boundaries are testable | Tasks 11, 12, 17, 18, 19 |
| AC-11 | Routing policy branches on artifact fields without exception state | Task 14 |
| AC-12 | Completion policy advances stage after configured graph conditions | Tasks 11, 14 |
| AC-13 | Exception policy handles failed/blocked outcomes separately from routing | Task 15 |
| AC-14 | Duplicate concurrent starts do not create duplicate task runs | Task 16 |
| AC-15 | Non-blocking projection failure does not block runtime | Task 18 |
| AC-16 | Workflow skill produces spec, agents, pack, workflow YAML, lint/explain/simulate before writing | Task 23 |
| AC-17 | Software delivery installs as a domain pack; core runs without it | Tasks 21, 22 |
| AC-18 | Southstar repo contains the migrated web board; no runtime dependency on external `~/apps/pi-web` | Tasks 25, 28 |
| AC-19 | `/api/southstar/*` routes read Southstar config/store/read-model from this repo | Tasks 26, 28 |
| AC-20 | Board UI uses Southstar work item/runtime vocabulary, not Northstar issue/lifecycle vocabulary | Tasks 25, 27, 28 |
| AC-21 | Web board is browser-verified against a local fixture/runtime DB | Tasks 27, 28, 29 |

## File Responsibility Map

Create or replace these Southstar core files:

- `src/types/runtime.ts`: fixed `RuntimeStatus`, task status, work item, task, history, event, and store DTO types.
- `src/types/workflow.ts`: Southstar workflow schema types: states, stages, tasks, routing, completion, exception, prompt refs, and resolved snapshots.
- `src/types/workflow-validation.ts`: stable validation error codes for Southstar workflow linting.
- `src/types/domain-pack.ts`: domain pack manifest, mappings, dashboard view, lint result, explain result types.
- `src/types/agent-catalog.ts`: agent profile, artifact defaults, task override, resolved profile types.
- `src/config/schema.ts`: `.southstar.yaml` typed `RuntimeConfig`.
- `src/config/load-config.ts`: config YAML loading and bootstrap env validation.
- `src/runtime/store.ts`: `SqliteSouthstarStore` with `work_items`, `work_item_tasks`, `work_item_history`.
- `src/runtime/work-items.ts`: local work item creation and immutable workflow snapshot initialization.
- `src/runtime/scheduler.ts`: pure DAG readiness calculation for stages/tasks.
- `src/runtime/evaluator.ts`: pure state reducer and command planner.
- `src/runtime/policy.ts`: predicate/action evaluation for routing, completion, and exception policies.
- `src/runtime/artifact-registry.ts`: artifact schema resolution, status normalization, query fields, and validation.
- `src/runtime/dispatcher.ts`: queued task execution boundary over host adapters.
- `src/runtime/projection-worker.ts`: source/projection result recording boundary.
- `src/runtime/inspect.ts`: read-only work item/session/task/projection summary.
- `src/runtime/watch.ts`: watch cycle orchestration over store/evaluator/dispatcher/projection.
- `src/packs/loader.ts`: pack/project asset loading.
- `src/packs/lint.ts`: pack lint implementation.
- `src/packs/explain.ts`: pack explanation implementation.
- `src/packs/resolver.ts`: pack + project overrides + prompts + agents + workflow snapshot resolver.
- `src/agents/catalog.ts`: project and pack agent catalog loading and override resolution.
- `src/workflows/parser.ts`: workflow YAML parse/load.
- `src/workflows/dag.ts`: task and stage DAG validation.
- `src/workflows/lint.ts`: workflow lint CLI implementation.
- `src/workflows/explain.ts`: workflow explain output.
- `src/workflows/simulate.ts`: deterministic workflow simulation over fixtures.
- `src/adapters/host/types.ts`: generic host adapter contracts.
- `src/adapters/host/fake.ts`: deterministic offline host adapter.
- `src/adapters/source/types.ts`: source intake adapter contracts.
- `src/adapters/source/local.ts`: local source adapter.
- `src/adapters/source/github.ts`: optional GitHub source adapter with fake-first tests.
- `src/adapters/projection/types.ts`: projection adapter contracts.
- `src/adapters/projection/fake.ts`: deterministic projection adapter.
- `src/adapters/projection/github.ts`: optional GitHub projection adapter with fake-first tests.
- `src/operator-dashboard/read-model.ts`: generic Southstar read model over `work_items` and `work_item_tasks`.
- `src/operator-dashboard/local-api.ts`: generic local API for external dashboards.
- `app/layout.tsx`: Southstar web app root layout.
- `app/page.tsx`: Southstar web board entrypoint.
- `app/globals.css`: board styles and responsive layout variables migrated from `pi-web` where needed.
- `app/api/southstar/projects/route.ts`: list/select Southstar project from `?config=`.
- `app/api/southstar/projects/[projectId]/route.ts`: return board read model.
- `app/api/southstar/projects/[projectId]/work-items/[workItemId]/route.ts`: return work item detail.
- `app/api/southstar/projects/[projectId]/work-items/[workItemId]/events/route.ts`: return event stream/read-model events.
- `app/api/southstar/projects/[projectId]/work-items/[workItemId]/actions/route.ts`: record operator action requests.
- `app/api/southstar/watch/route.ts`: start/stop/watch cycle endpoint backed by Southstar runtime, not Pi chat sessions.
- `components/southstar/SouthstarBoard.tsx`: migrated board component, grouping by fixed Southstar `runtime_status`.
- `components/southstar/WorkItemDrawer.tsx`: migrated detail drawer for work item history, sessions, artifacts, projection, and actions.
- `components/southstar/WorkItemEventModal.tsx`: migrated SSE/event detail modal.
- `components/southstar/WatchPanel.tsx`: migrated watch progress panel backed by Southstar watch events.
- `components/southstar/WorkspaceTabs.tsx`: generic workspace tabs if the web app keeps a multi-view shell.
- `components/southstar/workspace-views.tsx`: registry for board and additional Southstar views.
- `components/southstar/useWorkItemStream.ts`: renamed/adapted event stream hook.
- `components/southstar/useWatchStream.ts`: renamed/adapted watch stream hook.
- `lib/southstar/types.ts`: web-facing Southstar board/project/detail/event types.
- `lib/southstar/server-client.ts`: server-only resolver for `?config=` to `createSouthstarLocalApi`.
- `lib/southstar/local-api.ts`: in-repo local API wrapper; no out-of-tree loader.
- `src/cli/southstar.ts`: command parsing, help, version, config bootstrap.
- `src/cli/entrypoint.ts`: `southstar` binary entrypoint.
- `src/cli/work-command.ts`: `work create`, `work import`.
- `src/cli/pack-command.ts`: `pack list`, `pack install`, `pack lint`, `pack explain`.
- `src/cli/workflow-command.ts`: `workflow lint`, `workflow explain`, `workflow simulate`.
- `src/cli/watch-command.ts`: `watch`.
- `src/cli/doctor-command.ts`: `doctor`.
- `skills/southstar/SKILL.md`: workflow authoring skill entrypoint.
- `skills/southstar/scripts/lib/workflow-authoring.mjs`: interview state and artifact generation helpers.
- `skills/southstar/scripts/workflow-lint.mjs`: skill helper invoking runtime lint.

Create or replace these test and fixture areas:

- `tests/config/southstar-config.test.ts`
- `tests/runtime/store.test.ts`
- `tests/runtime/work-items.test.ts`
- `tests/runtime/scheduler.test.ts`
- `tests/runtime/evaluator.test.ts`
- `tests/runtime/artifact-registry.test.ts`
- `tests/runtime/policy.test.ts`
- `tests/runtime/race-idempotency.test.ts`
- `tests/packs/pack-loader.test.ts`
- `tests/packs/pack-lint-explain.test.ts`
- `tests/agents/agent-catalog.test.ts`
- `tests/workflows/workflow-validation.test.ts`
- `tests/workflows/workflow-simulate.test.ts`
- `tests/adapters/host-dispatcher.test.ts`
- `tests/adapters/source-projection.test.ts`
- `tests/operator-dashboard/read-model.test.ts`
- `tests/web/southstar-board-contract.test.ts`
- `tests/web/southstar-api-routes.test.ts`
- `tests/web/southstar-board-component.test.tsx`
- `tests/cli/southstar-cli.test.ts`
- `tests/skills/southstar-workflow-authoring.test.ts`
- `tests/fixtures/southstar/config/.southstar.yaml`
- `tests/fixtures/southstar/agents.yaml`
- `tests/fixtures/southstar/workflows/generic-request-resolution.yaml`
- `tests/fixtures/southstar/workflows/invalid/*.yaml`
- `tests/fixtures/southstar/packs/software_delivery/**`
- `tests/fixtures/southstar/packs/incident_ops/**`
- `tests/fixtures/southstar/packs/research/**`
- `tests/fixtures/southstar/packs/data_analysis/**`
- `tests/fixtures/southstar/packs/support_escalation/**`
- `tests/fixtures/southstar/web/runtime-db.ts`

---

## Phase 0: Southstar Identity And Guardrails

### Task 1: Project Identity, Scripts, And Test Index

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/index.test.ts`
- Create: `tests/spec/southstar-identity.test.ts`
- Modify: `src/cli/entrypoint.ts`
- Create: `src/cli/southstar.ts`
- Delete or stop importing: `src/cli/northstar.ts`

- [ ] **Step 1: Write the failing identity test**

Create `tests/spec/southstar-identity.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "../..");

test("package identity is Southstar only", async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@southstar/runtime");
  assert.deepEqual(pkg.bin, { southstar: "src/cli/entrypoint.ts" });
  assert.equal(pkg.scripts.southstar, "tsx src/cli/entrypoint.ts");
  assert.equal(pkg.scripts.northstar, undefined);
});

test("source files do not expose Northstar CLI naming", async () => {
  const entrypoint = await readFile(join(repoRoot, "src/cli/entrypoint.ts"), "utf8");
  assert.match(entrypoint, /southstar/);
  assert.doesNotMatch(entrypoint, /northstar/i);
});
```

Modify `tests/index.test.ts` to import this test:

```ts
await import("./spec/southstar-identity.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --version
npm test
```

Expected: `node --version` is `v22.22.2` or newer. `npm test` fails on package name/bin/script and CLI naming.

- [ ] **Step 3: Rename package identity**

Modify `package.json`:

```json
{
  "name": "@southstar/runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "southstar": "src/cli/entrypoint.ts"
  },
  "engines": {
    "node": ">=22.22.2"
  },
  "scripts": {
    "test": "tsx tests/index.test.ts",
    "southstar": "tsx src/cli/entrypoint.ts"
  }
}
```

Preserve the existing non-live test scripts only when they still point to Southstar tests. Remove or rename Northstar-specific script aliases as their tests are converted in later tasks.

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` has package name `@southstar/runtime`.

- [ ] **Step 4: Replace CLI naming shell**

Create `src/cli/southstar.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";

export const CLI_COMMANDS = [
  "doctor",
  "work",
  "intake",
  "projection",
  "pack",
  "workflow",
  "watch",
  "inspect",
] as const;

export type SouthstarCliCommand = typeof CLI_COMMANDS[number];

export interface BuiltCliCommand {
  command: SouthstarCliCommand;
  args: string[];
  config: RuntimeConfig;
  configPath: string;
  projectRootOverride?: string;
}

export function runSouthstarCli(argv: string[]): { command: SouthstarCliCommand; args: string[] } {
  const [command, ...args] = argv;
  if (!command || !CLI_COMMANDS.includes(command as SouthstarCliCommand)) {
    throw new Error(`Unknown southstar command: ${command ?? "(missing)"}`);
  }
  return { command: command as SouthstarCliCommand, args };
}

export function formatSouthstarHelp(): string {
  return [
    "Southstar generic multi-agent workflow runtime",
    "",
    "Usage:",
    "  southstar <command> [--config .southstar.yaml] [--project-root <path>]",
    "",
    "Commands:",
    ...CLI_COMMANDS.map((command) => `  southstar ${command}`),
  ].join("\n");
}

export function formatSouthstarVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
  return String(pkg.version);
}

export function buildCliCommand(argv: string[]): BuiltCliCommand {
  const parsed = runSouthstarCli(argv);
  const configPath = optionValue(parsed.args, "--config") ?? ".southstar.yaml";
  const projectRootOverride = optionValue(parsed.args, "--project-root");
  const config = loadConfig(configPath, projectRootOverride);
  return {
    command: parsed.command,
    args: parsed.args,
    config,
    configPath,
    ...(projectRootOverride ? { projectRootOverride } : {}),
  };
}

export function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}
```

Modify `src/cli/entrypoint.ts` to import from `southstar.ts` and route only Southstar commands.

- [ ] **Step 5: Run GREEN**

Run:

```bash
npm test
```

Expected: identity tests pass or the only remaining failures are expected downstream Northstar-specific tests that will be replaced by Southstar tests in subsequent tasks.

- [ ] **Step 6: Commit checkpoint when git is usable**

Run:

```bash
git status --short
git add package.json package-lock.json src/cli/entrypoint.ts src/cli/southstar.ts tests/index.test.ts tests/spec/southstar-identity.test.ts
git commit -m "chore: rename runtime identity to southstar"
```

Expected: commit succeeds in a valid git workspace. If `git status` reports this is not a git repository, record that in the task notes and continue without a commit.

### Task 2: Southstar Config Schema And Bootstrap Env

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/load-config.ts`
- Create: `tests/config/southstar-config.test.ts`
- Create: `tests/fixtures/southstar/config/.southstar.yaml`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write config fixture**

Create `tests/fixtures/southstar/config/.southstar.yaml`:

```yaml
schema_version: "0.1"
project:
  name: test-southstar-project
  root: /tmp/southstar-test-project
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 30
  lock_timeout_seconds: 300
  task_timeout_seconds: 3600
  max_retry_attempts: 2
intake:
  mode: local
sources:
  github:
    enabled: false
  jira:
    enabled: false
projection:
  github:
    enabled: false
    blocks_runtime: false
packs:
  search_paths:
    - .southstar/packs
    - packs
workflow:
  id: generic_request_resolution
  version: "0.1"
  path: .southstar/workflows/generic-request-resolution.yaml
agents:
  path: .southstar/agents.yaml
```

- [ ] **Step 2: Write failing config tests**

Create `tests/config/southstar-config.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_BOOTSTRAP_ENV, validateRuntimeConfig } from "../../src/config/schema.ts";
import { loadConfig, parseYamlSubset } from "../../src/config/load-config.ts";

const fixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.yaml");

test("loads Southstar config from .southstar.yaml shape", () => {
  const config = loadConfig(fixture, "/tmp/project-root-override");
  assert.equal(config.schemaVersion, "0.1");
  assert.equal(config.project.name, "test-southstar-project");
  assert.equal(config.project.root, "/tmp/project-root-override");
  assert.equal(config.runtime.dbPath, ".southstar/runtime/southstar.sqlite3");
  assert.equal(config.intake.mode, "local");
  assert.equal(config.projection.github.blocksRuntime, false);
  assert.deepEqual(config.packs.searchPaths, [".southstar/packs", "packs"]);
});

test("allows only Southstar bootstrap env names", () => {
  assert.deepEqual(ALLOWED_BOOTSTRAP_ENV, [
    "SOUTHSTAR_CONFIG",
    "SOUTHSTAR_PROJECT_ROOT",
    "SOUTHSTAR_DEBUG",
  ]);
});

test("validates intake modes and projection policy", () => {
  const parsed = parseYamlSubset(`
schema_version: "0.1"
project:
  name: x
  root: /tmp/x
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 30
  lock_timeout_seconds: 300
  task_timeout_seconds: 3600
  max_retry_attempts: 2
intake:
  mode: unsupported
sources:
  github:
    enabled: false
projection:
  github:
    enabled: false
    blocks_runtime: false
packs:
  search_paths: [packs]
workflow:
  id: generic_request_resolution
  version: "0.1"
  path: .southstar/workflows/generic-request-resolution.yaml
agents:
  path: .southstar/agents.yaml
`);
  assert.throws(() => validateRuntimeConfig(parsed), /intake.mode must be local, remote, or hybrid/);
});
```

Modify `tests/index.test.ts`:

```ts
await import("./config/southstar-config.test.ts");
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/southstar-config.test.ts
```

Expected: FAIL because the existing config schema expects `.northstar.yaml`, GitHub, git, and Northstar runtime fields.

- [ ] **Step 4: Implement Southstar config schema**

Replace `src/config/schema.ts` with Southstar config types:

```ts
export const ALLOWED_BOOTSTRAP_ENV = [
  "SOUTHSTAR_CONFIG",
  "SOUTHSTAR_PROJECT_ROOT",
  "SOUTHSTAR_DEBUG",
] as const;

export type IntakeMode = "local" | "remote" | "hybrid";

export interface RuntimeConfig {
  schemaVersion: string;
  project: {
    name: string;
    root: string;
  };
  runtime: {
    dbPath: string;
    heartbeatIntervalSeconds: number;
    lockTimeoutSeconds: number;
    taskTimeoutSeconds: number;
    maxRetryAttempts: number;
  };
  intake: {
    mode: IntakeMode;
  };
  sources: Record<string, { enabled: boolean }>;
  projection: Record<string, { enabled: boolean; blocksRuntime: boolean }>;
  packs: {
    searchPaths: string[];
  };
  workflow: {
    id: string;
    version: string;
    path: string;
  };
  agents: {
    path: string;
  };
}
```

Implement `validateRuntimeConfig(value: unknown): RuntimeConfig` using the existing helper style, with exact validations:

- `schema_version`, `project.name`, `project.root`, `runtime.db_path`, `workflow.id`, `workflow.version`, `workflow.path`, and `agents.path` are non-empty strings.
- `runtime.heartbeat_interval_seconds`, `runtime.lock_timeout_seconds`, `runtime.task_timeout_seconds`, and `runtime.max_retry_attempts` are non-negative integers.
- `intake.mode` is `local`, `remote`, or `hybrid`.
- `sources` and `projection` are mappings.
- each projection entry has boolean `enabled` and boolean `blocks_runtime`.
- `packs.search_paths` is a non-empty string array.

- [ ] **Step 5: Update config loading**

Modify `src/config/load-config.ts` so `loadConfig(path, projectRootOverride?)` loads the YAML, validates it, and applies the project root override without reading non-bootstrap env. Preserve the existing `parseYamlSubset` export so current YAML tests can keep using it.

- [ ] **Step 6: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/southstar-config.test.ts
npm test
```

Expected: focused config tests PASS. `npm test` has no Northstar config tests imported after this phase.

### Task 3: Legacy Core Guardrails

**Files:**
- Create: `tests/spec/southstar-core-language.test.ts`
- Modify: `tests/index.test.ts`
- Modify as failures require: `src/**`

- [ ] **Step 1: Write guardrail tests**

Create `tests/spec/southstar-core-language.test.ts`:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "../..");

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const results: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      results.push(...await sourceFiles(path));
    } else if (path.endsWith(".ts")) {
      results.push(path);
    }
  }
  return results;
}

test("Southstar core does not contain Northstar or software-delivery vocabulary", async () => {
  const files = await sourceFiles(join(repoRoot, "src"));
  const allowed = new Set([
    join(repoRoot, "src/adapters/source/github.ts"),
    join(repoRoot, "src/adapters/projection/github.ts"),
  ]);
  for (const file of files) {
    if (allowed.has(file)) continue;
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /\bNorthstar\b|\bnorthstar\b/);
    assert.doesNotMatch(text, /\bIssueSnapshot\b|\bissue_history\b|\bruntime_context_json\b/);
    assert.doesNotMatch(text, /\bpr_number\b|\bpull_request\b|\brelease_pending\b/);
  }
});

test("runtime source reads only Southstar bootstrap env directly", async () => {
  const files = await sourceFiles(join(repoRoot, "src"));
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const matches = text.match(/process\.env\.([A-Z0-9_]+)/g) ?? [];
    for (const match of matches) {
      assert.match(match, /process\.env\.(SOUTHSTAR_CONFIG|SOUTHSTAR_PROJECT_ROOT|SOUTHSTAR_DEBUG)$/);
    }
  }
});
```

Modify `tests/index.test.ts`:

```ts
await import("./spec/southstar-core-language.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/spec/southstar-core-language.test.ts
```

Expected: FAIL on current Northstar-shaped source files.

- [ ] **Step 3: Use the failures as the phase backlog**

Do not mass-edit source files blindly. Use the file list from the test failure to confirm which Northstar modules still need replacement in later tasks. Keep this test failing until the relevant source files are replaced by Southstar implementations.

- [ ] **Step 4: Phase 0 gate**

Run:

```bash
npm test
```

Expected after Tasks 1-2: Southstar identity/config tests pass. The legacy guardrail may remain failing until Phase 2 unless `tests/index.test.ts` imports it only after the replacement tasks. If it is not imported yet, run it manually and record current failures in implementation notes.

---

## Phase 1: Core Types, Store, Work Items, Packs, Agents, Workflows

### Task 4: Southstar Runtime Types

**Files:**
- Create: `src/types/runtime.ts`
- Modify: `src/types/control-plane.ts`
- Create: `tests/runtime/runtime-types.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write runtime type tests**

Create `tests/runtime/runtime-types.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  runtimeStatuses,
  taskStatuses,
  isRuntimeStatus,
  isTerminalRuntimeStatus,
  newWorkItemId,
} from "../../src/types/runtime.ts";

test("Southstar runtime status set is fixed and generic", () => {
  assert.deepEqual(runtimeStatuses, [
    "ready",
    "active",
    "waiting",
    "exception",
    "completed",
    "failed",
    "quarantined",
    "cancelled",
  ]);
  assert.equal(isRuntimeStatus("implementing"), false);
  assert.equal(isRuntimeStatus("active"), true);
  assert.equal(isTerminalRuntimeStatus("completed"), true);
  assert.equal(isTerminalRuntimeStatus("active"), false);
});

test("task status set is queryable and generic", () => {
  assert.deepEqual(taskStatuses, ["queued", "running", "succeeded", "failed", "blocked", "lost"]);
});

test("work item ids are opaque Southstar ids", () => {
  assert.match(newWorkItemId("00000000-0000-4000-8000-000000000001"), /^wi_00000000-0000-4000-8000-000000000001$/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/runtime-types.test.ts
```

Expected: FAIL because `src/types/runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime types**

Create `src/types/runtime.ts`:

```ts
export const runtimeStatuses = [
  "ready",
  "active",
  "waiting",
  "exception",
  "completed",
  "failed",
  "quarantined",
  "cancelled",
] as const;

export type RuntimeStatus = typeof runtimeStatuses[number];

export const terminalRuntimeStatuses = ["completed", "failed", "quarantined", "cancelled"] as const;
export type TerminalRuntimeStatus = typeof terminalRuntimeStatuses[number];

export const taskStatuses = ["queued", "running", "succeeded", "failed", "blocked", "lost"] as const;
export type TaskStatus = typeof taskStatuses[number];

export type WorkItemTaskKind = "stage_root" | "task_child";

export interface WorkItem {
  id: string;
  version: number;
  domain: string;
  work_type: string;
  source_provider: string;
  source_scope?: string | null;
  source_number?: number | null;
  source_external_id?: string | null;
  source_ref: string;
  source_url?: string | null;
  title: string;
  runtime_status: RuntimeStatus;
  workflow_state: string;
  workflow_id: string;
  workflow_version: string;
  workflow_fingerprint: string;
  current_stage?: string | null;
  current_stage_attempt: number;
  root_session_id?: string | null;
  priority: number;
  projection_json: Record<string, unknown>;
  workflow_json: Record<string, unknown>;
  state_json: Record<string, unknown>;
  snapshot_json: Record<string, unknown>;
  lock_owner?: string | null;
  lock_expires_at?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface WorkItemTask {
  id: string;
  work_item_id: string;
  stage_name: string;
  stage_attempt: number;
  task_id: string;
  task_attempt: number;
  kind: WorkItemTaskKind;
  parent_task_id?: string | null;
  role_name: string;
  agent_profile: string;
  host_adapter: string;
  root_session_id?: string | null;
  session_id?: string | null;
  child_run_id?: string | null;
  idempotency_key: string;
  status: TaskStatus;
  started_at?: string | null;
  last_seen_at?: string | null;
  completed_at?: string | null;
  depends_on_json: string[];
  input_json: Record<string, unknown>;
  artifact_kind?: string | null;
  artifact_status?: string | null;
  artifact_json?: Record<string, unknown> | null;
  error_json?: Record<string, unknown> | null;
  context_json: Record<string, unknown>;
}

export interface WorkItemHistoryEntry {
  id?: number;
  work_item_id: string;
  sequence?: number;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key?: string | null;
  created_at?: string;
}

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return typeof value === "string" && runtimeStatuses.includes(value as RuntimeStatus);
}

export function isTerminalRuntimeStatus(value: unknown): value is TerminalRuntimeStatus {
  return typeof value === "string" && terminalRuntimeStatuses.includes(value as TerminalRuntimeStatus);
}

export function newWorkItemId(uuid: string): string {
  return `wi_${uuid}`;
}
```

Modify `src/types/control-plane.ts` to re-export from `runtime.ts` only, or delete it after all imports move.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/runtime-types.test.ts
```

Expected: PASS.

### Task 5: Southstar Workflow Schema And DAG Validation

**Files:**
- Replace: `src/types/workflow.ts`
- Replace: `src/types/workflow-validation.ts`
- Create: `src/workflows/dag.ts`
- Create: `src/workflows/parser.ts`
- Create: `tests/workflows/workflow-validation.test.ts`
- Create: `tests/fixtures/southstar/workflows/generic-request-resolution.yaml`
- Create: `tests/fixtures/southstar/workflows/invalid/cyclic-tasks.yaml`
- Create: `tests/fixtures/southstar/workflows/invalid/missing-runtime-status-map.yaml`
- Create: `tests/fixtures/southstar/workflows/invalid/recovery-unbounded.yaml`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Create valid workflow fixture**

Create `tests/fixtures/southstar/workflows/generic-request-resolution.yaml` using the schema from the design:

```yaml
workflow:
  id: generic_request_resolution
  version: "0.1"
  domain: custom
  states:
    analyzing:
      runtime_status: active
    executing:
      runtime_status: active
    waiting_for_external_input:
      runtime_status: waiting
    completed:
      runtime_status: completed
  work_item:
    accepted_types:
      - request
      - issue
      - ticket
  stages:
    analysis:
      workflow_state: analyzing
      root_session:
        scope: stage_attempt
      tasks:
        inspect_context:
          agent_profile: context_analyst
          objective: Inspect the work item and available context to produce an execution path.
          inputs:
            include_work_item: true
            include_source_context: true
          output:
            artifact_kind: context_analysis
      routing_policy:
        rules: []
      completion_policy:
        all_success:
          - inspect_context
        on_satisfied:
          type: next_stage
          stage: execution
      exception_policy:
        rules:
          - name: retry_failed_analysis
            match:
              task: inspect_context
              status: failed_retryable
            action:
              type: retry_stage
              max_attempts: 2
    execution:
      workflow_state: executing
      root_session:
        scope: stage_attempt
      tasks:
        execute_plan:
          agent_profile: execution_agent
          objective: Execute the accepted plan and report the result.
          depends_on: []
          inputs:
            artifacts:
              - context_analysis
          output:
            artifact_kind: execution_result
            artifact:
              mode: extend
              required_fields:
                - actions_taken
                - commands_run
      routing_policy:
        rules: []
      completion_policy:
        all_success:
          - execute_plan
        on_satisfied:
          type: complete_work_item
          workflow_state: completed
      exception_policy:
        rules:
          - name: execution_failure_quarantines
            match:
              task: execute_plan
              status: failed_terminal
            action:
              type: quarantine
```

- [ ] **Step 2: Write workflow validation tests**

Create `tests/workflows/workflow-validation.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow } from "../../src/workflows/parser.ts";
import { WorkflowValidationError } from "../../src/types/workflow-validation.ts";

const fixtures = join(import.meta.dirname, "../fixtures/southstar/workflows");

test("loads dynamic stage and task graph workflow", () => {
  const workflow = loadWorkflow(join(fixtures, "generic-request-resolution.yaml"));
  assert.equal(workflow.id, "generic_request_resolution");
  assert.equal(workflow.states.analyzing.runtime_status, "active");
  assert.equal(workflow.stages.analysis.tasks.inspect_context.output.artifact_kind, "context_analysis");
  assert.deepEqual(workflow.stages.execution.completion_policy.all_success, ["execute_plan"]);
});

test("rejects workflow state without fixed runtime status mapping", () => {
  assert.throws(
    () => loadWorkflow(join(fixtures, "invalid/missing-runtime-status-map.yaml")),
    (error) => error instanceof WorkflowValidationError && error.code === "WORKFLOW_STATE_RUNTIME_STATUS_REQUIRED",
  );
});

test("rejects cyclic task graph", () => {
  assert.throws(
    () => loadWorkflow(join(fixtures, "invalid/cyclic-tasks.yaml")),
    (error) => error instanceof WorkflowValidationError && error.code === "WORKFLOW_TASK_DAG_CYCLE",
  );
});

test("rejects unbounded recovery action", () => {
  assert.throws(
    () => loadWorkflow(join(fixtures, "invalid/recovery-unbounded.yaml")),
    (error) => error instanceof WorkflowValidationError && error.code === "WORKFLOW_RECOVERY_UNBOUNDED",
  );
});
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/workflows/workflow-validation.test.ts
```

Expected: FAIL because parser/validation still expects Northstar role/stage YAML.

- [ ] **Step 4: Implement workflow types and validation errors**

Replace `src/types/workflow-validation.ts` with:

```ts
export type WorkflowValidationErrorCode =
  | "WORKFLOW_FIELD_REQUIRED"
  | "WORKFLOW_FIELD_TYPE"
  | "WORKFLOW_EMPTY_COLLECTION"
  | "WORKFLOW_STATE_RUNTIME_STATUS_REQUIRED"
  | "WORKFLOW_STATE_RUNTIME_STATUS_UNKNOWN"
  | "WORKFLOW_UNKNOWN_WORKFLOW_STATE"
  | "WORKFLOW_UNKNOWN_STAGE"
  | "WORKFLOW_UNKNOWN_TASK"
  | "WORKFLOW_TASK_DAG_CYCLE"
  | "WORKFLOW_STAGE_DAG_CYCLE"
  | "WORKFLOW_ROUTING_UNKNOWN_TASK"
  | "WORKFLOW_COMPLETION_UNKNOWN_TASK"
  | "WORKFLOW_COMPLETION_UNKNOWN_STAGE"
  | "WORKFLOW_RECOVERY_UNBOUNDED"
  | "WORKFLOW_PROMPT_REF_INVALID";

export class WorkflowValidationError extends Error {
  readonly code: WorkflowValidationErrorCode;
  readonly path: string;

  constructor(code: WorkflowValidationErrorCode, path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "WorkflowValidationError";
    this.code = code;
    this.path = path;
  }
}

export function workflowValidationError(
  code: WorkflowValidationErrorCode,
  path: string,
  message: string,
): WorkflowValidationError {
  return new WorkflowValidationError(code, path, message);
}
```

Replace `src/types/workflow.ts` with Southstar interfaces for `WorkflowDefinition`, `WorkflowStateDefinition`, `WorkflowStageDefinition`, `WorkflowTaskDefinition`, `RoutingPolicyDefinition`, `CompletionPolicyDefinition`, `ExceptionPolicyDefinition`, and `ResolvedWorkflowSnapshot`.

- [ ] **Step 5: Implement parser and DAG checks**

Create `src/workflows/parser.ts` with `loadWorkflow(path)` and `validateWorkflow(value)` using `parseYamlSubset`. Create `src/workflows/dag.ts` with:

```ts
export function assertAcyclicGraph(nodes: string[], edges: Array<[string, string]>, errorFactory: () => Error): void {
  const incoming = new Map(nodes.map((node) => [node, 0]));
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const [from, to] of edges) {
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    outgoing.get(from)?.push(to);
  }
  const queue = nodes.filter((node) => incoming.get(node) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift() as string;
    visited += 1;
    for (const next of outgoing.get(node) ?? []) {
      incoming.set(next, (incoming.get(next) ?? 0) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) throw errorFactory();
}
```

Validation must reject missing references, task cycles, normal stage cycles, routing unknown tasks, completion unknown tasks/stages, unbounded retry/return actions, and workflow states that do not map to a fixed runtime status.

- [ ] **Step 6: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/workflows/workflow-validation.test.ts
npm test
```

Expected: workflow validation tests PASS.

### Task 6: Three-Table SQLite Store

**Files:**
- Replace: `src/runtime/store.ts`
- Create: `tests/runtime/store.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write store tests**

Create `tests/runtime/store.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteSouthstarStore } from "../../src/runtime/store.ts";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "southstar-store-")), "southstar.sqlite3");
}

test("initializes exactly three runtime tables", () => {
  const store = SqliteSouthstarStore.open(tempDb());
  try {
    assert.deepEqual(store.listRuntimeTables(), ["work_item_history", "work_item_tasks", "work_items"]);
  } finally {
    store.close();
  }
});

test("creates local work item and appends audit history transactionally", () => {
  const store = SqliteSouthstarStore.open(tempDb());
  try {
    const created = store.createWorkItem({
      id: "wi_test",
      domain: "custom",
      work_type: "request",
      source_provider: "local",
      source_ref: "local:wi_test",
      title: "Test request",
      runtime_status: "ready",
      workflow_state: "analyzing",
      workflow_id: "generic_request_resolution",
      workflow_version: "0.1",
      workflow_fingerprint: "sha256:test",
      workflow_json: { workflow: { id: "generic_request_resolution" } },
      state_json: {},
      projection_json: {},
      snapshot_json: {},
      priority: 0,
    });
    assert.equal(created.version, 1);
    assert.equal(store.getWorkItem("wi_test").source_ref, "local:wi_test");
    assert.equal(store.listHistory("wi_test")[0]?.event_type, "work_item_created");
  } finally {
    store.close();
  }
});

test("optimistic update rejects stale version", () => {
  const store = SqliteSouthstarStore.open(tempDb());
  try {
    store.createWorkItem({
      id: "wi_lock",
      domain: "custom",
      work_type: "request",
      source_provider: "local",
      source_ref: "local:wi_lock",
      title: "Lock request",
      runtime_status: "ready",
      workflow_state: "analyzing",
      workflow_id: "generic_request_resolution",
      workflow_version: "0.1",
      workflow_fingerprint: "sha256:test",
      workflow_json: {},
      state_json: {},
      projection_json: {},
      snapshot_json: {},
      priority: 0,
    });
    store.updateWorkItemWithHistory("wi_lock", 1, { runtime_status: "active" }, [{
      work_item_id: "wi_lock",
      event_type: "operator_action",
      payload: { action: "activate" },
    }]);
    assert.throws(
      () => store.updateWorkItemWithHistory("wi_lock", 1, { runtime_status: "waiting" }, []),
      /optimistic lock conflict/,
    );
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/store.test.ts
```

Expected: FAIL because `SqliteSouthstarStore` and Southstar tables do not exist.

- [ ] **Step 3: Implement schema and store methods**

Replace `src/runtime/store.ts` with `SqliteSouthstarStore` using `node:sqlite`. `initialize()` must create:

```sql
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  domain TEXT NOT NULL,
  work_type TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_scope TEXT,
  source_number INTEGER,
  source_external_id TEXT,
  source_ref TEXT NOT NULL,
  source_url TEXT,
  title TEXT NOT NULL,
  runtime_status TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  workflow_fingerprint TEXT NOT NULL,
  current_stage TEXT,
  current_stage_attempt INTEGER NOT NULL,
  root_session_id TEXT,
  priority INTEGER NOT NULL,
  projection_json TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  lock_owner TEXT,
  lock_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS work_item_tasks (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  stage_attempt INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  parent_task_id TEXT,
  role_name TEXT NOT NULL,
  agent_profile TEXT NOT NULL,
  host_adapter TEXT NOT NULL,
  root_session_id TEXT,
  session_id TEXT,
  child_run_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  last_seen_at TEXT,
  completed_at TEXT,
  depends_on_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  artifact_kind TEXT,
  artifact_status TEXT,
  artifact_json TEXT,
  error_json TEXT,
  context_json TEXT NOT NULL,
  UNIQUE(work_item_id, stage_name, stage_attempt, task_id, task_attempt),
  UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS work_item_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(work_item_id, sequence),
  UNIQUE(work_item_id, idempotency_key)
);
```

Create the indexes from the design for status, source, workflow, session ids, artifacts, and history sequence.

Implement:

- `open(path)`
- `close()`
- `listRuntimeTables()`
- `createWorkItem(input)`
- `getWorkItem(id)`
- `listWorkItems(filter?)`
- `insertTask(task)`
- `updateTask(id, patch)`
- `listTasks(workItemId)`
- `appendHistory(entry)`
- `listHistory(workItemId)`
- `updateWorkItemWithHistory(id, expectedVersion, patch, historyEntries)`
- `recordIdempotentHistory(entry)`

All updates that touch work item state and history must use one SQLite transaction.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/store.test.ts
npm test
```

Expected: store tests PASS and `listRuntimeTables()` returns only the three Southstar tables.

### Task 7: Work Item Creation In Local Mode

**Files:**
- Create: `src/runtime/work-items.ts`
- Create: `tests/runtime/work-items.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write local creation tests**

Create `tests/runtime/work-items.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteSouthstarStore } from "../../src/runtime/store.ts";
import { createLocalWorkItem } from "../../src/runtime/work-items.ts";

test("local mode creates work item without external credentials", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "southstar-work-")), "southstar.sqlite3");
  const store = SqliteSouthstarStore.open(dbPath);
  try {
    const workItem = createLocalWorkItem(store, {
      id: "wi_local_1",
      domain: "custom",
      workType: "request",
      title: "Summarize a research request",
      workflowSnapshot: {
        id: "generic_request_resolution",
        version: "0.1",
        fingerprint: "sha256:workflow",
        initial_stage: "analysis",
        initial_workflow_state: "analyzing",
        workflow: { id: "generic_request_resolution" },
      },
    });
    assert.equal(workItem.source_provider, "local");
    assert.equal(workItem.source_ref, "local:wi_local_1");
    assert.equal(workItem.runtime_status, "ready");
    assert.equal(workItem.workflow_state, "analyzing");
    assert.equal(store.listHistory("wi_local_1")[0]?.event_type, "work_item_created");
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/work-items.test.ts
```

Expected: FAIL because `createLocalWorkItem` does not exist.

- [ ] **Step 3: Implement local creation**

Create `src/runtime/work-items.ts`:

```ts
import type { SqliteSouthstarStore } from "./store.ts";
import type { WorkItem } from "../types/runtime.ts";

export interface LocalWorkItemInput {
  id: string;
  domain: string;
  workType: string;
  title: string;
  workflowSnapshot: {
    id: string;
    version: string;
    fingerprint: string;
    initial_stage: string;
    initial_workflow_state: string;
    workflow: Record<string, unknown>;
  };
  priority?: number;
  now?: string;
}

export function createLocalWorkItem(store: SqliteSouthstarStore, input: LocalWorkItemInput): WorkItem {
  const now = input.now ?? new Date().toISOString();
  return store.createWorkItem({
    id: input.id,
    domain: input.domain,
    work_type: input.workType,
    source_provider: "local",
    source_ref: `local:${input.id}`,
    title: input.title,
    runtime_status: "ready",
    workflow_state: input.workflowSnapshot.initial_workflow_state,
    workflow_id: input.workflowSnapshot.id,
    workflow_version: input.workflowSnapshot.version,
    workflow_fingerprint: input.workflowSnapshot.fingerprint,
    current_stage: input.workflowSnapshot.initial_stage,
    current_stage_attempt: 0,
    priority: input.priority ?? 0,
    projection_json: {},
    workflow_json: input.workflowSnapshot.workflow,
    state_json: {},
    snapshot_json: {},
    created_at: now,
    updated_at: now,
  });
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/work-items.test.ts
npm test
```

Expected: PASS.

### Task 8: Agent Catalog Resolver

**Files:**
- Create: `src/types/agent-catalog.ts`
- Create: `src/agents/catalog.ts`
- Create: `tests/agents/agent-catalog.test.ts`
- Create: `tests/fixtures/southstar/agents.yaml`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Create catalog fixture**

Create `tests/fixtures/southstar/agents.yaml`:

```yaml
agents:
  context_analyst:
    display_name: Context Analyst
    host_adapter: pi
    agent: analyze
    model: github-copilot/gpt-5.3-codex
    load_skills:
      - evidence-gathering
    timeout_seconds: 3600
    persona:
      summary: Read-only context analyst.
      rules:
        - Do not edit files.
        - Prefer concrete source references.
    artifact_defaults:
      context_analysis:
        required_fields:
          - relevant_sources
          - key_findings
          - risks
          - recommended_plan
        success_statuses:
          - success
        failure_statuses:
          - blocked
          - failed_retryable
          - failed_terminal
  execution_agent:
    display_name: Execution Agent
    host_adapter: codex
    agent: code
    model: gpt-5-codex
    load_skills:
      - test-driven-development
    timeout_seconds: 7200
    persona:
      summary: Executes accepted plans.
      rules:
        - Use tests before implementation.
    artifact_defaults:
      execution_result:
        required_fields:
          - actions_taken
          - commands_run
        success_statuses:
          - success
        failure_statuses:
          - blocked
          - failed_retryable
          - failed_terminal
```

- [ ] **Step 2: Write resolver tests**

Create `tests/agents/agent-catalog.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadAgentCatalog, resolveAgentProfile } from "../../src/agents/catalog.ts";

const fixture = join(import.meta.dirname, "../fixtures/southstar/agents.yaml");

test("loads agent profiles from project catalog", () => {
  const catalog = loadAgentCatalog(fixture);
  assert.equal(catalog.agents.context_analyst.host_adapter, "pi");
  assert.deepEqual(catalog.agents.context_analyst.load_skills, ["evidence-gathering"]);
});

test("task overrides extend skills and timeout by default", () => {
  const catalog = loadAgentCatalog(fixture);
  const resolved = resolveAgentProfile(catalog, "context_analyst", {
    timeout_seconds: 7200,
    load_skills: { add: ["playwright"] },
  });
  assert.equal(resolved.timeout_seconds, 7200);
  assert.deepEqual(resolved.load_skills, ["evidence-gathering", "playwright"]);
  assert.equal(resolved.artifact_defaults.context_analysis.required_fields[0], "relevant_sources");
});

test("replace override must be explicit for load_skills", () => {
  const catalog = loadAgentCatalog(fixture);
  const resolved = resolveAgentProfile(catalog, "context_analyst", {
    load_skills: { mode: "replace", value: ["browser"] },
  });
  assert.deepEqual(resolved.load_skills, ["browser"]);
});
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/agents/agent-catalog.test.ts
```

Expected: FAIL because agent catalog resolver does not exist.

- [ ] **Step 4: Implement catalog types and resolver**

Create `src/types/agent-catalog.ts` with `AgentCatalog`, `AgentProfile`, `TaskAgentOverrides`, and `ResolvedAgentProfile`. Create `src/agents/catalog.ts` with:

- `loadAgentCatalog(path)`
- `validateAgentCatalog(value)`
- `resolveAgentProfile(catalog, profileName, overrides?)`

Rules:

- profile must declare `display_name`, `host_adapter`, `agent`, `load_skills`, `timeout_seconds`, `artifact_defaults`.
- task overrides default to extend.
- `mode: replace` must be explicit for replacement.
- unknown profile throws `AGENT_PROFILE_UNKNOWN`.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/agents/agent-catalog.test.ts
npm test
```

Expected: PASS.

### Task 9: Artifact Registry And Validation

**Files:**
- Create: `src/runtime/artifact-registry.ts`
- Create: `tests/runtime/artifact-registry.test.ts`
- Create: `tests/fixtures/southstar/packs/custom/artifact-schemas/context-analysis.yaml`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write artifact registry tests**

Create `tests/runtime/artifact-registry.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArtifactRegistry,
  validateTaskArtifact,
  normalizeArtifactStatus,
} from "../../src/runtime/artifact-registry.ts";

test("validates required fields and normalizes status", () => {
  const registry = buildArtifactRegistry({
    context_analysis: {
      schema_ref: "artifact-schemas/context-analysis.yaml",
      status_field: "status",
      success_statuses: ["success"],
      failure_statuses: ["blocked", "failed_retryable", "failed_terminal"],
      required_fields: ["relevant_sources", "key_findings", "risks", "recommended_plan"],
      query_fields: ["status", "risk_level", "requires_human"],
      schema_version: "0.1",
    },
  });
  const result = validateTaskArtifact(registry, {
    artifactKind: "context_analysis",
    taskRunId: "task_1",
    stageAttempt: 1,
    taskAttempt: 1,
    payload: {
      status: "success",
      relevant_sources: ["README.md"],
      key_findings: ["Use local mode"],
      risks: [],
      recommended_plan: "Proceed",
      risk_level: "low",
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.normalizedStatus, "success");
  assert.equal(result.lineage.schema_version, "0.1");
});

test("rejected artifact returns audit payload and cannot be accepted", () => {
  const registry = buildArtifactRegistry({
    context_analysis: {
      schema_ref: "artifact-schemas/context-analysis.yaml",
      status_field: "status",
      success_statuses: ["success"],
      failure_statuses: ["blocked"],
      required_fields: ["key_findings"],
      query_fields: ["status"],
      schema_version: "0.1",
    },
  });
  const result = validateTaskArtifact(registry, {
    artifactKind: "context_analysis",
    taskRunId: "task_1",
    stageAttempt: 1,
    taskAttempt: 1,
    payload: { status: "success" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.audit.event_type, "artifact_rejected");
  assert.match(result.audit.payload.reason as string, /missing required field key_findings/);
});

test("token-shaped values are rejected from artifact json", () => {
  const registry = buildArtifactRegistry({
    execution_result: {
      schema_ref: "artifact-schemas/execution-result.yaml",
      status_field: "status",
      success_statuses: ["success"],
      failure_statuses: ["blocked"],
      required_fields: ["actions_taken"],
      query_fields: ["status"],
      schema_version: "0.1",
    },
  });
  assert.equal(normalizeArtifactStatus(registry.execution_result, "success"), "success");
  const result = validateTaskArtifact(registry, {
    artifactKind: "execution_result",
    taskRunId: "task_2",
    stageAttempt: 1,
    taskAttempt: 1,
    payload: { status: "success", actions_taken: ["used ghp_1234567890abcdef1234567890abcdef1234"] },
  });
  assert.equal(result.accepted, false);
  assert.match(result.audit.payload.reason as string, /secret-shaped value/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/artifact-registry.test.ts
```

Expected: FAIL because artifact registry does not exist.

- [ ] **Step 3: Implement artifact registry**

Create `src/runtime/artifact-registry.ts` with:

- `ArtifactRegistry`
- `ArtifactKindDefinition`
- `buildArtifactRegistry(definitions)`
- `normalizeArtifactStatus(definition, rawStatus)`
- `validateTaskArtifact(registry, input)`
- secret scan for common token prefixes: `ghp_`, `github_pat_`, `sk-`, `xoxb-`, `xoxp-`

Validation output must include:

```ts
type ArtifactValidationResult =
  | {
      accepted: true;
      artifactKind: string;
      normalizedStatus: "success" | "blocked" | "failed_retryable" | "failed_terminal" | "informational";
      queryFields: Record<string, unknown>;
      lineage: {
        task_run_id: string;
        stage_attempt: number;
        task_attempt: number;
        schema_version: string;
        validation_result: "accepted";
      };
    }
  | {
      accepted: false;
      audit: {
        event_type: "artifact_rejected";
        payload: Record<string, unknown>;
      };
    };
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/artifact-registry.test.ts
npm test
```

Expected: PASS.

### Task 10: Domain Pack Loader, Lint, Explain, And Snapshot Resolver

**Files:**
- Create: `src/types/domain-pack.ts`
- Create: `src/packs/loader.ts`
- Create: `src/packs/lint.ts`
- Create: `src/packs/explain.ts`
- Create: `src/packs/resolver.ts`
- Create: `tests/packs/pack-loader.test.ts`
- Create: `tests/packs/pack-lint-explain.test.ts`
- Create: `tests/fixtures/southstar/packs/software_delivery/pack.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/agents.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/workflows/software-delivery-basic.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/prompts/inspect-repo.md`
- Create: `tests/fixtures/southstar/packs/software_delivery/artifact-schemas/repo-inspection.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/fixtures/basic-issue.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/source-mapping.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/projection-mapping.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/dashboard-view.yaml`
- Create: `tests/fixtures/southstar/packs/software_delivery/lint-rules.yaml`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Create software-delivery fixture pack manifest**

Create `tests/fixtures/southstar/packs/software_delivery/pack.yaml`:

```yaml
pack:
  id: software_delivery
  version: "0.1"
  display_name: Software Delivery
  work_types:
    - issue
    - request
  workflows:
    - software_delivery_basic
  artifact_kinds:
    - repo_inspection
    - implementation_result
    - verification_result
  sources:
    - github
    - local
  projections:
    - github
  dashboard_views:
    - delivery_board
```

Create the referenced files with real minimal content:

```yaml
# artifact-schemas/repo-inspection.yaml
artifact:
  kind: repo_inspection
  schema_version: "0.1"
  status_field: status
  success_statuses: [success]
  failure_statuses: [blocked, failed_retryable, failed_terminal]
  required_fields: [status, relevant_files, risks]
  query_fields: [status, risk_level]
```

```md
<!-- prompts/inspect-repo.md -->
Inspect the repository for files relevant to the work item. Return repo_inspection JSON only.
```

- [ ] **Step 2: Write pack tests**

Create `tests/packs/pack-loader.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadDomainPack } from "../../src/packs/loader.ts";

const packPath = join(import.meta.dirname, "../fixtures/southstar/packs/software_delivery");

test("loads installable domain pack assets", () => {
  const pack = loadDomainPack(packPath);
  assert.equal(pack.manifest.pack.id, "software_delivery");
  assert.equal(pack.agentsPath.endsWith("agents.yaml"), true);
  assert.equal(pack.workflowPaths.length, 1);
  assert.equal(pack.promptPaths.length, 1);
  assert.equal(pack.artifactSchemaPaths.length, 1);
});
```

Create `tests/packs/pack-lint-explain.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { lintDomainPack } from "../../src/packs/lint.ts";
import { explainDomainPack } from "../../src/packs/explain.ts";

const packPath = join(import.meta.dirname, "../fixtures/southstar/packs/software_delivery");

test("lints manifest references, workflow ids, schemas, prompts, mappings, fixtures, and dashboard views", () => {
  const result = lintDomainPack(packPath);
  assert.deepEqual(result.errors, []);
  assert.equal(result.checked.manifest, true);
  assert.equal(result.checked.workflows, 1);
  assert.equal(result.checked.artifact_schemas, 1);
  assert.equal(result.checked.prompts, 1);
  assert.equal(result.checked.fixtures, 1);
  assert.equal(result.checked.dashboard_views, 1);
});

test("explains domain pack contents and operational risks", () => {
  const explanation = explainDomainPack(packPath);
  assert.match(explanation.summary, /Software Delivery/);
  assert.deepEqual(explanation.work_types, ["issue", "request"]);
  assert.deepEqual(explanation.sources, ["github", "local"]);
  assert.ok(explanation.operational_risks.some((risk) => risk.includes("GitHub")));
});
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/packs/pack-loader.test.ts
node --disable-warning=ExperimentalWarning tests/packs/pack-lint-explain.test.ts
```

Expected: FAIL because pack modules do not exist.

- [ ] **Step 4: Implement pack loader/lint/explain**

Implement `loadDomainPack(path)` to return manifest plus resolved asset paths. Implement `lintDomainPack(path)` to validate every manifest reference points to an existing file and that workflow ids/artifact kinds match referenced files. Implement `explainDomainPack(path)` to return structured summary:

```ts
interface DomainPackExplanation {
  id: string;
  display_name: string;
  summary: string;
  work_types: string[];
  workflows: string[];
  artifact_kinds: string[];
  sources: string[];
  projections: string[];
  dashboard_views: string[];
  operational_risks: string[];
}
```

- [ ] **Step 5: Implement snapshot resolver**

Create `src/packs/resolver.ts` with `resolveWorkItemWorkflowSnapshot(input)` that:

- loads pack assets from search paths,
- loads project `.southstar/agents.yaml`,
- applies project overrides over pack assets,
- resolves workflow YAML,
- inlines `prompt_ref` content,
- resolves artifact schemas into the artifact registry,
- resolves task agent profiles,
- computes a stable SHA-256 fingerprint over the resolved JSON,
- returns `ResolvedWorkflowSnapshot`.

Write a focused test in `tests/packs/pack-lint-explain.test.ts`:

```ts
test("resolved workflow snapshot is immutable and includes prompts, agents, schemas, and pack version", () => {
  const snapshot = resolveWorkItemWorkflowSnapshot({
    packPath,
    workflowId: "software_delivery_basic",
    projectAgentsPath: join(import.meta.dirname, "../fixtures/southstar/agents.yaml"),
  });
  assert.equal(snapshot.pack.id, "software_delivery");
  assert.equal(snapshot.pack.version, "0.1");
  assert.equal(snapshot.workflow.id, "software_delivery_basic");
  assert.match(snapshot.fingerprint, /^sha256:/);
  assert.equal(snapshot.prompts["prompts/inspect-repo.md"].includes("Inspect the repository"), true);
  assert.equal(snapshot.agent_profiles.repo_inspector.host_adapter, "codex");
  assert.equal(snapshot.artifacts.repo_inspection.required_fields.includes("relevant_files"), true);
});
```

- [ ] **Step 6: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/packs/pack-loader.test.ts
node --disable-warning=ExperimentalWarning tests/packs/pack-lint-explain.test.ts
npm test
```

Expected: PASS.

---

## Phase 2: Scheduler, Evaluator, Policy, Race Controls

### Task 11: Pure DAG Scheduler

**Files:**
- Create: `src/runtime/scheduler.ts`
- Create: `tests/runtime/scheduler.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write scheduler tests**

Create `tests/runtime/scheduler.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { computeReadyTasks } from "../../src/runtime/scheduler.ts";

const stage = {
  tasks: {
    inspect_context: { depends_on: [] },
    execute_plan: { depends_on: ["inspect_context"] },
    specialist_review: { depends_on: ["execute_plan"] },
  },
};

test("scheduler dispatches dependency-free tasks first", () => {
  assert.deepEqual(computeReadyTasks(stage, []), ["inspect_context"]);
});

test("scheduler waits for dependencies", () => {
  assert.deepEqual(computeReadyTasks(stage, [{ task_id: "inspect_context", status: "succeeded" }]), ["execute_plan"]);
});

test("scheduler does not re-dispatch queued or running tasks", () => {
  assert.deepEqual(computeReadyTasks(stage, [{ task_id: "inspect_context", status: "queued" }]), []);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/scheduler.test.ts
```

Expected: FAIL because scheduler does not exist.

- [ ] **Step 3: Implement scheduler**

Create `src/runtime/scheduler.ts` with pure functions:

- `computeReadyTasks(stage, taskRows)`
- `dependencySatisfied(taskId, taskRows)`
- `activeOrCompletedTaskIds(taskRows)`

Rules:

- dependency-free tasks are ready when no row exists for current attempt.
- dependency tasks are ready only when all dependencies have current-attempt `succeeded`.
- queued/running/succeeded/blocked/failed/lost current-attempt rows prevent duplicate dispatch unless evaluator creates a new task attempt.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/scheduler.test.ts
npm test
```

Expected: PASS.

### Task 12: Stage Root And Task Dispatch Evaluator

**Files:**
- Create: `src/runtime/evaluator.ts`
- Create: `tests/runtime/evaluator.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write evaluator dispatch tests**

Create `tests/runtime/evaluator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkItem } from "../../src/runtime/evaluator.ts";

test("ready work item starts stage root session and dependency-free task", () => {
  const result = evaluateWorkItem({
    now: "2026-06-05T00:00:00.000Z",
    workItem: {
      id: "wi_1",
      version: 1,
      runtime_status: "ready",
      workflow_state: "analyzing",
      current_stage: "analysis",
      current_stage_attempt: 0,
      root_session_id: null,
    },
    tasks: [],
    history: [],
    workflow: {
      stages: {
        analysis: {
          workflow_state: "analyzing",
          root_session: { scope: "stage_attempt" },
          tasks: {
            inspect_context: {
              agent_profile: "context_analyst",
              objective: "Inspect context",
              depends_on: [],
              output: { artifact_kind: "context_analysis" },
            },
          },
          routing_policy: { rules: [] },
          completion_policy: { all_success: ["inspect_context"], on_satisfied: { type: "complete_work_item", workflow_state: "completed" } },
          exception_policy: { rules: [] },
        },
      },
      resolved_agent_profiles: {
        context_analyst: { host_adapter: "fake", agent: "analyze", load_skills: [], timeout_seconds: 3600 },
      },
    },
  });
  assert.equal(result.workItemPatch.runtime_status, "active");
  assert.equal(result.workItemPatch.current_stage_attempt, 1);
  assert.equal(result.taskInserts[0]?.kind, "stage_root");
  assert.equal(result.taskInserts[1]?.kind, "task_child");
  assert.equal(result.taskInserts[1]?.task_id, "inspect_context");
  assert.match(result.taskInserts[1]?.idempotency_key ?? "", /wi_1:analysis:1:inspect_context:1/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/evaluator.test.ts
```

Expected: FAIL because evaluator does not exist.

- [ ] **Step 3: Implement evaluator start/dispatch path**

Create `src/runtime/evaluator.ts` with `evaluateWorkItem(input)` returning:

```ts
interface EvaluationResult {
  workItemPatch: Record<string, unknown>;
  taskInserts: WorkItemTask[];
  taskUpdates: Array<{ id: string; patch: Record<string, unknown> }>;
  history: WorkItemHistoryEntry[];
  dispatchCommands: Array<{ task_id: string; task_row_id: string; idempotency_key: string }>;
  operatorMessages: Array<{ code: string; message: string }>;
}
```

Implement only:

- `runtime_status=ready` starts the current stage.
- increment `current_stage_attempt`.
- create `stage_root` row.
- create queued `task_child` rows for dependency-free tasks.
- set `runtime_status=active`, `workflow_state=stage.workflow_state`, `root_session_id`.
- write history events `stage_root_started` and `task_queued`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/evaluator.test.ts
npm test
```

Expected: PASS.

### Task 13: Artifact Submission, Validation, And Rejection Semantics

**Files:**
- Modify: `src/runtime/evaluator.ts`
- Modify: `src/runtime/artifact-registry.ts`
- Create: `tests/runtime/evaluator-artifacts.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write artifact evaluator tests**

Create `tests/runtime/evaluator-artifacts.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkItem } from "../../src/runtime/evaluator.ts";

test("accepted task artifact updates task row and can feed policies", () => {
  const result = evaluateWorkItem({
    now: "2026-06-05T00:00:00.000Z",
    workItem: {
      id: "wi_artifact",
      version: 2,
      runtime_status: "active",
      workflow_state: "analyzing",
      current_stage: "analysis",
      current_stage_attempt: 1,
    },
    tasks: [{
      id: "task_inspect",
      task_id: "inspect_context",
      stage_name: "analysis",
      stage_attempt: 1,
      task_attempt: 1,
      status: "running",
      artifact_kind: "context_analysis",
    }],
    events: [{
      type: "artifact_submitted",
      task_row_id: "task_inspect",
      stage_attempt: 1,
      task_attempt: 1,
      artifact_kind: "context_analysis",
      payload: {
        status: "success",
        relevant_sources: ["README.md"],
        key_findings: ["Found spec"],
        risks: [],
        recommended_plan: "Proceed",
      },
    }],
    workflow: workflowFixtureWithArtifactRegistry(),
  });
  assert.equal(result.taskUpdates[0]?.patch.status, "succeeded");
  assert.equal(result.taskUpdates[0]?.patch.artifact_status, "success");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_accepted"), true);
});

test("rejected artifact is audited and cannot advance task or work item", () => {
  const result = evaluateWorkItem({
    now: "2026-06-05T00:00:00.000Z",
    workItem: {
      id: "wi_reject",
      version: 2,
      runtime_status: "active",
      workflow_state: "analyzing",
      current_stage: "analysis",
      current_stage_attempt: 1,
    },
    tasks: [{
      id: "task_inspect",
      task_id: "inspect_context",
      stage_name: "analysis",
      stage_attempt: 1,
      task_attempt: 1,
      status: "running",
      artifact_kind: "context_analysis",
    }],
    events: [{
      type: "artifact_submitted",
      task_row_id: "task_inspect",
      stage_attempt: 1,
      task_attempt: 1,
      artifact_kind: "context_analysis",
      payload: { status: "success" },
    }],
    workflow: workflowFixtureWithArtifactRegistry(),
  });
  assert.equal(result.taskUpdates.length, 0);
  assert.equal(result.workItemPatch.runtime_status, undefined);
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), true);
});
```

Define `workflowFixtureWithArtifactRegistry()` in the test file with a resolved artifact registry for `context_analysis`.

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/evaluator-artifacts.test.ts
```

Expected: FAIL because evaluator does not consume artifact events.

- [ ] **Step 3: Implement artifact event handling**

Extend `evaluateWorkItem`:

- reject artifacts whose `stage_attempt` is not current; audit `artifact_stale_ignored`.
- validate artifact through resolved registry.
- accepted artifact updates task row: `status`, `completed_at`, `artifact_kind`, `artifact_status`, `artifact_json`, `context_json.lineage`.
- rejected artifact writes history only.
- policies only receive accepted artifact facts.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/evaluator-artifacts.test.ts
npm test
```

Expected: PASS.

### Task 14: Routing And Completion Policy

**Files:**
- Create: `src/runtime/policy.ts`
- Modify: `src/runtime/evaluator.ts`
- Create: `tests/runtime/policy.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write policy tests**

Create `tests/runtime/policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRoutingPolicy, evaluateCompletionPolicy } from "../../src/runtime/policy.ts";

test("routing policy starts declared task based on artifact field", () => {
  const actions = evaluateRoutingPolicy({
    rules: [{
      name: "high_risk_result_needs_specialist_review",
      after: "execute_plan",
      when: {
        all: [{
          artifact_field: {
            artifact: "execution_result",
            field: "risk_level",
            equals: "high",
          },
        }],
      },
      action: { start_tasks: ["specialist_review"] },
    }],
  }, {
    artifacts: {
      execution_result: { risk_level: "high" },
    },
    completedTaskId: "execute_plan",
  });
  assert.deepEqual(actions, [{ type: "start_tasks", task_ids: ["specialist_review"], rule: "high_risk_result_needs_specialist_review" }]);
});

test("completion policy supports all_success and one_of", () => {
  const result = evaluateCompletionPolicy({
    all_success: ["execute_plan"],
    one_of: ["specialist_verify", "human_verify"],
    on_satisfied: { type: "complete_work_item", workflow_state: "completed" },
  }, {
    taskStatuses: {
      execute_plan: "succeeded",
      specialist_verify: "succeeded",
    },
  });
  assert.deepEqual(result, { satisfied: true, action: { type: "complete_work_item", workflow_state: "completed" } });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/policy.test.ts
```

Expected: FAIL because `src/runtime/policy.ts` does not exist.

- [ ] **Step 3: Implement normal policy evaluation**

Create `src/runtime/policy.ts`:

- `evaluateRoutingPolicy(policy, facts)`
- `evaluateCompletionPolicy(policy, facts)`
- predicate support for artifact field, task status, stage attempt, retry attempt, runtime config flag, and projection record exists.
- actions for `start_tasks`, `next_stage`, and `complete_work_item`.

Rules:

- routing starts only predeclared tasks in current stage.
- completion can move to declared next stage or complete work item.
- normal routing never sets `runtime_status=exception`.
- external state predicates require a fact/artifact already present in store state.

- [ ] **Step 4: Wire evaluator**

Extend `evaluateWorkItem` after accepted artifact/task success:

- evaluate routing policy and queue newly activated tasks.
- call scheduler for ready dependencies.
- evaluate completion policy.
- on stage completion with `next_stage`, update `current_stage`, reset root session to null, set `runtime_status=ready` for next evaluator cycle or start next stage in the same cycle if simpler and still transactional.
- on `complete_work_item`, set `runtime_status=completed`, `workflow_state`, `completed_at`, and clear active root session.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/policy.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/evaluator.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/evaluator-artifacts.test.ts
npm test
```

Expected: PASS.

### Task 15: Exception Policy And Bounded Recovery

**Files:**
- Modify: `src/runtime/policy.ts`
- Modify: `src/runtime/evaluator.ts`
- Create: `tests/runtime/exception-policy.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write exception tests**

Create `tests/runtime/exception-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExceptionPolicy } from "../../src/runtime/policy.ts";

test("failed retryable task retries task within bounded attempts", () => {
  const result = evaluateExceptionPolicy({
    rules: [{
      name: "retry_failed_analysis",
      match: { task: "inspect_context", status: "failed_retryable" },
      action: { type: "retry_task", max_attempts: 2 },
    }],
  }, {
    task: "inspect_context",
    status: "failed_retryable",
    taskAttempt: 1,
  });
  assert.deepEqual(result, { type: "retry_task", max_attempts: 2 });
});

test("exhausted retry quarantines work item", () => {
  const result = evaluateExceptionPolicy({
    rules: [{
      name: "retry_failed_analysis",
      match: { task: "inspect_context", status: "failed_retryable" },
      action: { type: "retry_task", max_attempts: 2, on_exhausted: "quarantine" },
    }],
  }, {
    task: "inspect_context",
    status: "failed_retryable",
    taskAttempt: 2,
  });
  assert.deepEqual(result, { type: "quarantine", reason: "retry_failed_analysis exhausted after 2 attempts" });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/exception-policy.test.ts
```

Expected: FAIL because exception policy support is incomplete.

- [ ] **Step 3: Implement exception policy**

Support actions:

- `retry_task`
- `retry_stage`
- `return_to_stage`
- `quarantine`
- `fail`
- `cancel`

Rules:

- retry/return requires `max_attempts` or equivalent guard from resolved runtime config.
- exception policy is only for abnormal outcomes: validation failure, task failed/blocked/lost, adapter failed, stale session.
- `return_to_stage` creates a new stage attempt and carry-forward context only for fields declared under `carry_forward`.
- exhausted retry/return follows `on_exhausted` or quarantines by default.

- [ ] **Step 4: Wire evaluator**

Extend evaluator:

- failed_retryable/blocked task artifacts or host failures set `runtime_status=exception` while policy is evaluated.
- successful recovery action returns to `active` only after new task/stage rows are queued.
- terminal failure sets `failed`.
- operator quarantine sets `quarantined`.
- audit events: `exception_raised`, `exception_policy_selected`, `task_retry_queued`, `stage_retry_started`, `work_item_quarantined`, `work_item_failed`.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/exception-policy.test.ts
npm test
```

Expected: PASS.

### Task 16: Race And Idempotency Controls

**Files:**
- Modify: `src/runtime/store.ts`
- Modify: `src/runtime/evaluator.ts`
- Create: `tests/runtime/race-idempotency.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write race tests**

Create `tests/runtime/race-idempotency.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteSouthstarStore } from "../../src/runtime/store.ts";

test("duplicate task dispatch idempotency key creates one task row", () => {
  const store = SqliteSouthstarStore.open(join(mkdtempSync(join(tmpdir(), "southstar-race-")), "db.sqlite3"));
  try {
    store.insertTask({
      id: "task_a",
      work_item_id: "wi_race",
      stage_name: "analysis",
      stage_attempt: 1,
      task_id: "inspect_context",
      task_attempt: 1,
      kind: "task_child",
      role_name: "context_analyst",
      agent_profile: "context_analyst",
      host_adapter: "fake",
      idempotency_key: "wi_race:analysis:1:inspect_context:1",
      status: "queued",
      depends_on_json: [],
      input_json: {},
      context_json: {},
    });
    store.insertTask({
      id: "task_b",
      work_item_id: "wi_race",
      stage_name: "analysis",
      stage_attempt: 1,
      task_id: "inspect_context",
      task_attempt: 1,
      kind: "task_child",
      role_name: "context_analyst",
      agent_profile: "context_analyst",
      host_adapter: "fake",
      idempotency_key: "wi_race:analysis:1:inspect_context:1",
      status: "queued",
      depends_on_json: [],
      input_json: {},
      context_json: {},
    });
    assert.equal(store.listTasks("wi_race").length, 1);
  } finally {
    store.close();
  }
});

test("stale stage attempt artifact is audited but ignored", () => {
  // Use evaluator fixture from evaluator-artifacts test.
  // Expected history contains artifact_stale_ignored and no task/work item patch.
});
```

Replace the second test body with a concrete call to `evaluateWorkItem` using a current work item at `stage_attempt=2` and an artifact event with `stage_attempt=1`.

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/race-idempotency.test.ts
```

Expected: FAIL until idempotent insert and stale attempt handling are implemented.

- [ ] **Step 3: Implement idempotent task/history writes**

In `SqliteSouthstarStore`:

- `insertTask(task)` catches unique idempotency conflicts and returns the existing row.
- `recordIdempotentHistory(entry)` uses `(work_item_id, idempotency_key)`.
- `updateWorkItemWithHistory` requires expected version and throws a typed `OptimisticLockConflictError` when no row updates.

In evaluator:

- every dispatch command has deterministic idempotency key.
- every policy action history entry has deterministic idempotency key.
- stale stage/task attempts audit and do not advance state.

- [ ] **Step 4: Add concurrent start simulation**

Extend `tests/runtime/race-idempotency.test.ts`:

```ts
test("two evaluator results for same ready work item create one stage root and one task after idempotent persistence", () => {
  // Arrange a ready work item.
  // Evaluate twice from the same snapshot.
  // Persist first result successfully.
  // Persist second result; task insert returns existing row and work item update throws optimistic conflict.
  // Reload state and assert only one stage_root and one task_child exist.
});
```

Use concrete fixture builders from `tests/runtime/evaluator.test.ts` by exporting them or duplicating the small fixture locally.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/race-idempotency.test.ts
npm test
```

Expected: PASS. Race cases covered: duplicate starts, duplicate dispatch, stale artifact, and optimistic conflict reload path.

---

## Phase 3: Dispatcher, Projection, CLI, Inspect, Watch, Simulate

### Task 17: Dispatcher And Host Adapter Callback Boundary

**Files:**
- Create: `src/adapters/host/types.ts`
- Replace: `src/adapters/host/fake.ts`
- Create: `src/runtime/dispatcher.ts`
- Create: `tests/adapters/host-dispatcher.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write dispatcher tests**

Create `tests/adapters/host-dispatcher.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchQueuedTask } from "../../src/runtime/dispatcher.ts";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";

test("dispatcher starts queued task through host adapter and records session ids", async () => {
  const adapter = new FakeHostAdapter({
    rootSessionId: "root_1",
    sessionId: "session_1",
    childRunId: "child_1",
  });
  const result = await dispatchQueuedTask(adapter, {
    id: "task_1",
    work_item_id: "wi_1",
    kind: "task_child",
    stage_name: "analysis",
    stage_attempt: 1,
    task_id: "inspect_context",
    task_attempt: 1,
    idempotency_key: "wi_1:analysis:1:inspect_context:1",
    agent_profile: "context_analyst",
    host_adapter: "fake",
    input_json: { objective: "Inspect" },
  });
  assert.deepEqual(result.taskPatch, {
    status: "running",
    root_session_id: "root_1",
    session_id: "session_1",
    child_run_id: "child_1",
  });
  assert.equal(result.history.event_type, "task_dispatched");
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/host-dispatcher.test.ts
```

Expected: FAIL because generic dispatcher boundary does not exist.

- [ ] **Step 3: Implement host contracts**

Create `src/adapters/host/types.ts`:

```ts
export interface HostDispatchInput {
  workItemId: string;
  stageName: string;
  stageAttempt: number;
  taskId: string;
  taskAttempt: number;
  idempotencyKey: string;
  objective: string;
  prompt?: string;
  input: Record<string, unknown>;
  agentProfile: Record<string, unknown>;
}

export interface HostDispatchResult {
  rootSessionId: string;
  sessionId: string;
  childRunId: string;
  status: "running" | "queued";
}

export interface HostAdapter {
  readonly name: string;
  dispatchTask(input: HostDispatchInput): Promise<HostDispatchResult>;
}
```

Implement `FakeHostAdapter` and `dispatchQueuedTask`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/host-dispatcher.test.ts
npm test
```

Expected: PASS.

### Task 18: Source And Projection Modes

**Files:**
- Create: `src/adapters/source/types.ts`
- Create: `src/adapters/source/local.ts`
- Create: `src/adapters/source/github.ts`
- Create: `src/adapters/projection/types.ts`
- Create: `src/adapters/projection/fake.ts`
- Create: `src/adapters/projection/github.ts`
- Create: `src/runtime/projection-worker.ts`
- Create: `tests/adapters/source-projection.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write source/projection tests**

Create `tests/adapters/source-projection.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { LocalSourceAdapter } from "../../src/adapters/source/local.ts";
import { FakeProjectionAdapter } from "../../src/adapters/projection/fake.ts";
import { applyProjectionResult } from "../../src/runtime/projection-worker.ts";

test("local source creates normalized work item input without credentials", async () => {
  const adapter = new LocalSourceAdapter();
  const result = await adapter.createWorkItem({
    id: "wi_source",
    title: "Local request",
    workType: "request",
    domain: "custom",
  });
  assert.equal(result.source_provider, "local");
  assert.equal(result.source_ref, "local:wi_source");
});

test("non-blocking projection failure records retryable state without blocking runtime", async () => {
  const adapter = new FakeProjectionAdapter({ status: "failed", error: "rate limited" });
  const result = await adapter.sync({ workItemId: "wi_projection", provider: "github" });
  const patch = applyProjectionResult({
    runtimeStatus: "active",
    projectionPolicy: { blocksRuntime: false },
    result,
  });
  assert.equal(patch.workItemPatch.runtime_status, undefined);
  assert.equal(patch.history.event_type, "projection_failed");
  assert.equal(patch.history.payload.retryable, true);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/source-projection.test.ts
```

Expected: FAIL because source/projection adapters do not exist.

- [ ] **Step 3: Implement adapters**

Implement generic contracts:

- `SourceAdapter.importWorkItems(input)`
- `SourceAdapter.createWorkItem(input)`
- `ProjectionAdapter.sync(input)`

`LocalSourceAdapter` must require no credentials. `github.ts` files should define interfaces and deterministic fakeable boundaries; do not run network calls in default tests.

Implement `applyProjectionResult`:

- appends projection history.
- updates `projection_json`.
- if `blocksRuntime=false`, does not set runtime status.
- if `blocksRuntime=true` and projection fails, routes through exception policy input.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/source-projection.test.ts
npm test
```

Expected: PASS.

### Task 19: CLI Surface, Doctor, Work, Pack, Workflow, Watch, Inspect

**Files:**
- Modify: `src/cli/southstar.ts`
- Create: `src/cli/doctor-command.ts`
- Create: `src/cli/work-command.ts`
- Create: `src/cli/pack-command.ts`
- Create: `src/cli/workflow-command.ts`
- Create: `src/cli/watch-command.ts`
- Modify: `src/cli/entrypoint.ts`
- Create: `tests/cli/southstar-cli.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write CLI tests**

Create `tests/cli/southstar-cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { runSouthstarCli, formatSouthstarHelp } from "../../src/cli/southstar.ts";
import { buildWorkCreateCommand } from "../../src/cli/work-command.ts";

test("Southstar help lists v1 commands", () => {
  const help = formatSouthstarHelp();
  for (const command of [
    "doctor",
    "work",
    "intake",
    "projection",
    "pack",
    "workflow",
    "watch",
    "inspect",
  ]) {
    assert.match(help, new RegExp(`southstar ${command}`));
  }
});

test("parses work create command", () => {
  assert.deepEqual(runSouthstarCli(["work", "create", "--workflow", "generic_request_resolution", "--type", "request"]), {
    command: "work",
    args: ["create", "--workflow", "generic_request_resolution", "--type", "request"],
  });
});

test("work create requires workflow and type", () => {
  assert.throws(() => buildWorkCreateCommand(["create", "--type", "request"]), /--workflow is required/);
  assert.throws(() => buildWorkCreateCommand(["create", "--workflow", "generic_request_resolution"]), /--type is required/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/cli/southstar-cli.test.ts
```

Expected: FAIL for missing command builders.

- [ ] **Step 3: Implement CLI command builders**

Implement command builders:

- `doctor --config .southstar.yaml`
- `work create --workflow <id> --type <type> [--title <title>]`
- `work import --source <provider>`
- `intake --source <provider>`
- `projection sync --provider <provider>`
- `pack list`
- `pack install <domain>`
- `pack lint <domain-or-path>`
- `pack explain <domain>`
- `workflow lint <path>`
- `workflow explain <path>`
- `workflow simulate --workflow <path> --fixture <path>`
- `watch [--max-cycles N] [--interval-ms N]`
- `inspect --work <id-or-source-ref>`

Keep builders side-effect free. Entrypoint can call the side-effect handlers.

- [ ] **Step 4: Implement doctor**

`doctor` checks:

- config loads.
- DB directory can be created.
- pack search paths exist or are reported as warnings.
- configured workflow path exists.
- configured agents path exists.
- local mode needs no external credentials.
- remote/hybrid mode reports missing source credentials as actionable diagnostics.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/cli/southstar-cli.test.ts
npm test
```

Expected: PASS.

### Task 20: Inspect, Dashboard Read Model, Watch Cycle, Workflow Simulate

**Files:**
- Create: `src/runtime/inspect.ts`
- Create: `src/runtime/watch.ts`
- Create: `src/workflows/simulate.ts`
- Replace: `src/operator-dashboard/read-model.ts`
- Replace: `src/operator-dashboard/local-api.ts`
- Create: `tests/operator-dashboard/read-model.test.ts`
- Create: `tests/workflows/workflow-simulate.test.ts`
- Create: `tests/runtime/watch.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write inspect/read-model tests**

Create `tests/operator-dashboard/read-model.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkItemDetail } from "../../src/operator-dashboard/read-model.ts";

test("read model lists stage root and child sessions from work_item_tasks", () => {
  const detail = buildWorkItemDetail({
    workItem: {
      id: "wi_dashboard",
      title: "Dashboard request",
      runtime_status: "active",
      workflow_state: "analyzing",
      current_stage: "analysis",
      current_stage_attempt: 1,
      projection_json: {},
    },
    tasks: [
      { id: "root", kind: "stage_root", root_session_id: "root_1", status: "running", stage_name: "analysis", task_id: "stage_root" },
      { id: "child", kind: "task_child", root_session_id: "root_1", session_id: "session_1", child_run_id: "child_1", status: "running", stage_name: "analysis", task_id: "inspect_context" },
    ],
    history: [],
  });
  assert.equal(detail.sessions.root_sessions[0]?.root_session_id, "root_1");
  assert.equal(detail.sessions.child_runs[0]?.child_run_id, "child_1");
});
```

- [ ] **Step 2: Write workflow simulate test**

Create `tests/workflows/workflow-simulate.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { simulateWorkflow } from "../../src/workflows/simulate.ts";

test("workflow simulate returns stage/task/policy trace for fixture", () => {
  const result = simulateWorkflow({
    workflowPath: join(import.meta.dirname, "../fixtures/southstar/workflows/generic-request-resolution.yaml"),
    fixture: {
      id: "wi_sim",
      title: "Simulated request",
      work_type: "request",
      artifacts: {
        inspect_context: { status: "success", relevant_sources: [], key_findings: [], risks: [], recommended_plan: "execute" },
        execute_plan: { status: "success", actions_taken: [], commands_run: [] },
      },
    },
  });
  assert.equal(result.final_runtime_status, "completed");
  assert.deepEqual(result.trace.map((item) => item.event), ["stage_started", "task_succeeded", "stage_completed", "stage_started", "task_succeeded", "work_item_completed"]);
});
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/read-model.test.ts
node --disable-warning=ExperimentalWarning tests/workflows/workflow-simulate.test.ts
```

Expected: FAIL because read model and simulate are not generic Southstar implementations.

- [ ] **Step 4: Implement inspect/read model**

Implement:

- `inspectWorkItem(store, idOrSourceRef)`
- `buildWorkItemDetail({ workItem, tasks, history })`
- redaction for token-shaped values in history/artifacts/projection.
- summary fields: runtime status, workflow state, current stage, stage attempt, sessions, active tasks, latest artifacts, projection state, next suggested action.

- [ ] **Step 5: Implement watch cycle**

Create `src/runtime/watch.ts`:

- load active/ready/waiting/exception work items.
- collect queued host/projection facts.
- evaluate each work item with optimistic locking.
- persist task/history/work item transactionally.
- dispatch queued tasks after commit.
- on optimistic conflict, reload and re-evaluate once.
- export `runSouthstarWatchCycle(configPath)` for one web/CLI-triggered cycle, returning `{ status: "ran", dispatched: number, evaluated: number }`.
- export `getSouthstarWatchStatus()` returning `{ status: "idle" }` for the v1 web status endpoint.

Default watch tests use fake adapters only.

- [ ] **Step 6: Implement simulate**

Create `src/workflows/simulate.ts`:

- load workflow.
- create an in-memory work item.
- run evaluator with fixture artifacts.
- return trace, final status, and policy decisions.
- never write SQLite or call host adapters.

- [ ] **Step 7: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/read-model.test.ts
node --disable-warning=ExperimentalWarning tests/workflows/workflow-simulate.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/watch.test.ts
npm test
```

Expected: PASS.

---

## Phase 4: Domain Packs

### Task 21: Software Delivery Pack

**Files:**
- Create: `packs/software_delivery/pack.yaml`
- Create: `packs/software_delivery/agents.yaml`
- Create: `packs/software_delivery/workflows/software-delivery-basic.yaml`
- Create: `packs/software_delivery/prompts/inspect-repo.md`
- Create: `packs/software_delivery/prompts/implement-change.md`
- Create: `packs/software_delivery/prompts/verify-change.md`
- Create: `packs/software_delivery/artifact-schemas/repo-inspection.yaml`
- Create: `packs/software_delivery/artifact-schemas/implementation-result.yaml`
- Create: `packs/software_delivery/artifact-schemas/verification-result.yaml`
- Create: `packs/software_delivery/source-mapping.yaml`
- Create: `packs/software_delivery/projection-mapping.yaml`
- Create: `packs/software_delivery/dashboard-view.yaml`
- Create: `packs/software_delivery/lint-rules.yaml`
- Create: `tests/packs/software-delivery-pack.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write pack acceptance tests**

Create `tests/packs/software-delivery-pack.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { lintDomainPack } from "../../src/packs/lint.ts";
import { explainDomainPack } from "../../src/packs/explain.ts";
import { resolveWorkItemWorkflowSnapshot } from "../../src/packs/resolver.ts";

const packPath = join(import.meta.dirname, "../../packs/software_delivery");

test("software delivery pack lints and explains without changing Southstar core", () => {
  const lint = lintDomainPack(packPath);
  assert.deepEqual(lint.errors, []);
  const explanation = explainDomainPack(packPath);
  assert.equal(explanation.id, "software_delivery");
  assert.deepEqual(explanation.work_types, ["issue", "request"]);
  assert.equal(explanation.artifact_kinds.includes("implementation_result"), true);
});

test("software delivery concepts live in pack snapshot, not core runtime fields", () => {
  const snapshot = resolveWorkItemWorkflowSnapshot({
    packPath,
    workflowId: "software_delivery_basic",
  });
  assert.equal(snapshot.pack.id, "software_delivery");
  assert.equal(snapshot.workflow.domain, "software_delivery");
  assert.equal(JSON.stringify(snapshot.workflow).includes("pull_request"), true);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/packs/software-delivery-pack.test.ts
```

Expected: FAIL until built-in pack assets exist.

- [ ] **Step 3: Implement pack assets**

Create `packs/software_delivery/pack.yaml` matching the design manifest. Create workflow `software-delivery-basic.yaml` with stages:

- `implementation`, workflow_state `implementing`, tasks `inspect_repo` and `implement_change`.
- `verification`, workflow_state `verifying`, task `verify_change`.
- `waiting_release`, workflow_state `waiting_for_release`, task `record_release_decision` or projection-only placeholder.
- `completed`, workflow_state `completed`.

Keep repo, PR, review, and release fields inside artifact schemas and prompts, not core types.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/packs/software-delivery-pack.test.ts
npm test
```

Expected: PASS.

### Task 22: Starter Pack Manifests For First-Version Domains

**Files:**
- Create: `packs/incident_ops/**`
- Create: `packs/research/**`
- Create: `packs/data_analysis/**`
- Create: `packs/support_escalation/**`
- Create: `tests/packs/starter-packs.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write starter pack tests**

Create `tests/packs/starter-packs.test.ts`:

```ts
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { lintDomainPack } from "../../src/packs/lint.ts";
import { explainDomainPack } from "../../src/packs/explain.ts";

const domains = ["incident_ops", "research", "data_analysis", "support_escalation"];

for (const domain of domains) {
  test(`${domain} starter pack lints and explains`, () => {
    const packPath = join(import.meta.dirname, `../../packs/${domain}`);
    assert.deepEqual(lintDomainPack(packPath).errors, []);
    assert.equal(explainDomainPack(packPath).id, domain);
  });
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/packs/starter-packs.test.ts
```

Expected: FAIL until starter pack assets exist.

- [ ] **Step 3: Add starter pack assets**

For each starter pack, create:

```text
packs/<domain>/
  pack.yaml
  agents.yaml
  workflows/<domain>-basic.yaml
  prompts/<primary-task>.md
  artifact-schemas/<primary-artifact>.yaml
  fixtures/basic.yaml
  source-mapping.yaml
  projection-mapping.yaml
  dashboard-view.yaml
  lint-rules.yaml
```

Use domain-specific names only inside the pack:

- `incident_ops`: work types `alert`, `incident`; workflow states `diagnosing`, `remediating`, `completed`.
- `research`: work types `question`, `request`; workflow states `researching`, `synthesizing`, `completed`.
- `data_analysis`: work types `dataset`, `request`; workflow states `profiling`, `analyzing`, `completed`.
- `support_escalation`: work types `ticket`, `escalation`; workflow states `triaging`, `responding`, `waiting_for_customer`, `completed`.

Each basic workflow must have one analysis task and one completion task so `workflow simulate` can run a real trace.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/packs/starter-packs.test.ts
npm test
```

Expected: PASS. Core Southstar tests pass even if no pack is installed into `.southstar/packs`.

---

## Phase 5: Workflow Skill

### Task 23: Southstar Workflow Authoring Skill

**Files:**
- Create: `skills/southstar/SKILL.md`
- Create: `skills/southstar/scripts/lib/workflow-authoring.mjs`
- Create: `skills/southstar/scripts/workflow-lint.mjs`
- Create: `tests/skills/southstar-workflow-authoring.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write skill helper tests**

Create `tests/skills/southstar-workflow-authoring.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowInterview,
  generateWorkflowArtifacts,
} from "../../skills/southstar/scripts/lib/workflow-authoring.mjs";

test("workflow interview asks domain questions instead of YAML authoring", () => {
  const interview = createWorkflowInterview({
    objective: "Handle customer support escalation",
    domain: "support_escalation",
    workType: "ticket",
  });
  assert.deepEqual(interview.steps.map((step) => step.id), [
    "workflow_objective",
    "domain_and_work_item_type",
    "source_projection_mode",
    "agent_team_design",
    "stage_list",
    "tasks_per_stage",
    "task_dependencies",
    "artifacts_and_success_criteria",
    "routing_branches",
    "completion_policy",
    "exception_retry_policy",
    "output_review",
  ]);
});

test("generates design spec, agents draft, pack draft, workflow YAML draft, and commands", () => {
  const artifacts = generateWorkflowArtifacts({
    objective: "Handle customer support escalation",
    domain: "support_escalation",
    workType: "ticket",
    stages: ["triage", "response"],
    tasks: [
      { stage: "triage", id: "inspect_ticket", agentProfile: "support_triager", artifactKind: "ticket_analysis" },
      { stage: "response", id: "draft_response", agentProfile: "support_writer", artifactKind: "support_response" },
    ],
  });
  assert.match(artifacts.designSpec, /Handle customer support escalation/);
  assert.match(artifacts.agentsYaml, /support_triager/);
  assert.match(artifacts.packYaml, /support_escalation/);
  assert.match(artifacts.workflowYaml, /workflow:/);
  assert.deepEqual(artifacts.reviewCommands, [
    "southstar workflow lint .southstar/workflows/support_escalation-generated.yaml",
    "southstar workflow explain .southstar/workflows/support_escalation-generated.yaml",
    "southstar workflow simulate --workflow .southstar/workflows/support_escalation-generated.yaml --fixture .southstar/packs/support_escalation/fixtures/generated.yaml",
    "southstar pack explain .southstar/packs/support_escalation",
  ]);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/southstar-workflow-authoring.test.ts
```

Expected: FAIL because skill files do not exist.

- [ ] **Step 3: Implement skill entrypoint**

Create `skills/southstar/SKILL.md`:

```md
---
name: southstar
description: Operate and author Southstar generic multi-agent workflows from a consumer repository.
---

# Southstar Workflow Skill

Use this skill when the user wants to design, lint, explain, simulate, create, inspect, watch, or operate a Southstar workflow.

## Authoring Flow

Ask domain questions and generate artifacts; do not ask users to hand-author YAML.

1. Workflow objective
2. Domain and work item type
3. Source/projection mode
4. Agent team design
5. Stage list
6. Tasks per stage
7. Task dependencies
8. Artifacts and success criteria
9. Routing branches
10. Completion policy
11. Exception/retry policy
12. Output review

Before writing generated files, run or propose:

- `southstar workflow lint .southstar/workflows/<id>.yaml`
- `southstar workflow explain .southstar/workflows/<id>.yaml`
- `southstar workflow simulate --workflow .southstar/workflows/<id>.yaml --fixture <fixture>`
- `southstar pack explain .southstar/packs/<domain>`
```

- [ ] **Step 4: Implement skill helpers**

Implement `createWorkflowInterview` and `generateWorkflowArtifacts` in `skills/southstar/scripts/lib/workflow-authoring.mjs`. The generator must return strings for:

- design spec
- `.southstar/agents.yaml` draft
- `.southstar/packs/<domain>/pack.yaml` draft
- `.southstar/workflows/<workflow-id>.yaml` draft
- fixture draft
- review commands

The helper does not write files by default.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/southstar-workflow-authoring.test.ts
npm test
```

Expected: PASS.

### Task 24: CLI Integration For Skill Lint/Explain/Simulate Before Writing

**Files:**
- Modify: `skills/southstar/scripts/workflow-lint.mjs`
- Modify: `tests/skills/southstar-workflow-authoring.test.ts`
- Modify: `src/cli/workflow-command.ts`
- Modify: `src/cli/pack-command.ts`

- [ ] **Step 1: Add command execution tests**

Extend `tests/skills/southstar-workflow-authoring.test.ts`:

```ts
test("workflow-lint helper builds argv arrays for review commands", async () => {
  const { buildReviewCommandSpecs } = await import("../../skills/southstar/scripts/workflow-lint.mjs");
  const specs = buildReviewCommandSpecs({
    workflowPath: ".southstar/workflows/generated.yaml",
    fixturePath: ".southstar/packs/custom/fixtures/generated.yaml",
    packPath: ".southstar/packs/custom",
  });
  assert.deepEqual(specs, [
    ["node", "--run", "southstar", "--", "workflow", "lint", ".southstar/workflows/generated.yaml"],
    ["node", "--run", "southstar", "--", "workflow", "explain", ".southstar/workflows/generated.yaml"],
    ["node", "--run", "southstar", "--", "workflow", "simulate", "--workflow", ".southstar/workflows/generated.yaml", "--fixture", ".southstar/packs/custom/fixtures/generated.yaml"],
    ["node", "--run", "southstar", "--", "pack", "explain", ".southstar/packs/custom"],
  ]);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/southstar-workflow-authoring.test.ts
```

Expected: FAIL until helper exists.

- [ ] **Step 3: Implement argv specs**

In `skills/southstar/scripts/workflow-lint.mjs`, export `buildReviewCommandSpecs(input)` and keep all commands as argv arrays. Do not shell-chain lint/explain/simulate.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/southstar-workflow-authoring.test.ts
npm test
```

Expected: PASS.

---

## Phase 6: Integrated Southstar Web Board From pi-web

### Task 25: Web App Package, Scripts, And Southstar Type Contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create: `app/globals.css`
- Create: `lib/southstar/types.ts`
- Create: `tests/web/southstar-board-contract.test.ts`
- Modify: `tests/index.test.ts`
- Read/reference only: `/home/timmypai/apps/pi-web/package.json`
- Read/reference only: `/home/timmypai/apps/pi-web/lib/northstar/types.ts`
- Read/reference only: `/home/timmypai/apps/pi-web/app/layout.tsx`
- Read/reference only: `/home/timmypai/apps/pi-web/app/page.tsx`
- Read/reference only: `/home/timmypai/apps/pi-web/app/globals.css`

- [ ] **Step 1: Write the Southstar web type contract test**

Create `tests/web/southstar-board-contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  southstarRuntimeStatusOrder,
  type SouthstarBoard,
  type SouthstarBoardCard,
} from "../../lib/southstar/types.ts";

const repoRoot = join(import.meta.dirname, "../..");

test("Southstar board types use work item and runtime status vocabulary", () => {
  assert.deepEqual(southstarRuntimeStatusOrder, [
    "ready",
    "active",
    "waiting",
    "exception",
    "completed",
    "failed",
    "quarantined",
    "cancelled",
  ]);
  const card: SouthstarBoardCard = {
    workItemId: "wi_1",
    sourceRef: "local:wi_1",
    title: "Analyze request",
    runtimeStatus: "active",
    workflowState: "analyzing",
    currentStage: "analysis",
    latestHostAdapter: "fake",
    dependencyCount: 0,
    blocked: false,
    latestRootSessionId: "root_1",
    latestChildRunId: "child_1",
    activeStreamAdapter: "fake",
    activeStreamSessionId: "session_1",
    activeStreamChildRunId: "child_1",
    lastHeartbeatAt: null,
    nextRecommendedAction: "wait_for_task",
    projectionFailure: false,
  };
  const board: SouthstarBoard = {
    project: {
      projectId: "test",
      name: "Test",
      root: "/tmp/test",
      configPath: "/tmp/test/.southstar.yaml",
      runtimeDbPath: "/tmp/test/.southstar/runtime/southstar.sqlite3",
      capabilities: {
        hostAdapters: ["fake"],
        optionalParameters: ["skill", "model"],
        mcpServers: { status: "design_only", configurable: false, supported: false },
      },
    },
    groups: [{ runtimeStatus: "active", cards: [card] }],
  };
  assert.equal(board.groups[0]?.cards[0]?.workItemId, "wi_1");
});

test("web Southstar files do not keep Northstar route/type names", async () => {
  const files = [
    "lib/southstar/types.ts",
    "app/page.tsx",
    "app/layout.tsx",
  ];
  for (const file of files) {
    const text = await readFile(join(repoRoot, file), "utf8");
    assert.doesNotMatch(text, /Northstar|northstar|issueId|lifecycle/i);
  }
});
```

Modify `tests/index.test.ts`:

```ts
await import("./web/southstar-board-contract.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/web/southstar-board-contract.test.ts
```

Expected: FAIL because the Southstar web files do not exist.

- [ ] **Step 3: Add Next/React web dependencies and scripts**

Modify `package.json` to keep the runtime command and add web commands:

```json
{
  "scripts": {
    "test": "tsx tests/index.test.ts",
    "southstar": "tsx src/cli/entrypoint.ts",
    "web:dev": "next dev -p 3030 --webpack",
    "web:build": "next build --webpack",
    "web:start": "next start -p 3030"
  },
  "dependencies": {
    "next": "16.2.1",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "server-only": "^0.0.1"
  },
  "devDependencies": {
    "@types/node": "^25",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5"
  }
}
```

Preserve the existing runtime dev dependencies such as `tsx` and `c8`.

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` includes Next/React packages.

- [ ] **Step 4: Add Next and TypeScript config**

Create `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "allowImportingTsExtensions": true,
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Create Southstar web type contract**

Create `lib/southstar/types.ts` by adapting `/home/timmypai/apps/pi-web/lib/northstar/types.ts` and renaming the model:

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type SouthstarHostAdapter = "fake" | "codex" | "opencode" | "pi";
export type SouthstarOptionalParameter = "skill" | "model";
export type SouthstarRuntimeStatus =
  | "ready"
  | "active"
  | "waiting"
  | "exception"
  | "completed"
  | "failed"
  | "quarantined"
  | "cancelled";

export const southstarRuntimeStatusOrder: SouthstarRuntimeStatus[] = [
  "ready",
  "active",
  "waiting",
  "exception",
  "completed",
  "failed",
  "quarantined",
  "cancelled",
];

export interface SouthstarProjectCapabilities {
  hostAdapters: readonly SouthstarHostAdapter[];
  optionalParameters: readonly SouthstarOptionalParameter[];
  mcpServers: {
    status: "design_only";
    configurable: false;
    supported: false;
  };
}

export interface SouthstarProjectSummary {
  id?: string;
  projectId: string;
  name: string;
  root: string;
  configPath: string;
  runtimeDbPath: string;
  capabilities: SouthstarProjectCapabilities;
}

export interface SouthstarBoard {
  project: SouthstarProjectSummary;
  groups: SouthstarBoardGroup[];
}

export interface SouthstarBoardGroup {
  runtimeStatus: SouthstarRuntimeStatus;
  cards: SouthstarBoardCard[];
}

export interface SouthstarBoardCard {
  workItemId: string;
  sourceRef: string;
  sourceUrl?: string | null;
  title: string;
  runtimeStatus: SouthstarRuntimeStatus;
  workflowState: string;
  currentStage: string | null;
  latestHostAdapter: SouthstarHostAdapter | null;
  dependencyCount: number;
  blocked: boolean;
  latestRootSessionId: string | null;
  latestChildRunId: string | null;
  activeStreamAdapter: SouthstarHostAdapter | null;
  activeStreamSessionId: string | null;
  activeStreamChildRunId: string | null;
  lastHeartbeatAt: string | null;
  nextRecommendedAction: string;
  projectionFailure: boolean;
}

export interface SouthstarRunEvent {
  id: string;
  sequence: number;
  eventType: string;
  severity: "info" | "warning" | "error";
  createdAt: string | null;
  summary: string;
  payloadPreview: JsonValue;
}

export interface SouthstarSessionLink {
  host: SouthstarHostAdapter;
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  streamAdapter: SouthstarHostAdapter | null;
  streamSessionId: string | null;
  href: string | null;
}

export interface SouthstarAcceptedArtifact {
  taskId: string;
  kind: string;
  status: string;
  summary: string;
}

export interface SouthstarWorkItemDetail {
  workItem: JsonObject;
  title: string;
  sourceUrl: string | null;
  inspect: JsonObject;
  timeline: SouthstarRunEvent[];
  sessionLinks: SouthstarSessionLink[];
  acceptedArtifacts: SouthstarAcceptedArtifact[];
}
```

- [ ] **Step 6: Create minimal app shell**

Create `app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Southstar",
  description: "Southstar generic multi-agent workflow board",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Create `app/page.tsx`:

```tsx
export default function Home() {
  return (
    <main style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      Southstar board shell
    </main>
  );
}
```

Task 27 replaces this placeholder with the migrated `SouthstarBoard` component.

Create `app/globals.css` by carrying over the CSS variables needed by the `pi-web` board:

```css
:root {
  --bg: #0f1115;
  --bg-panel: #161a22;
  --bg-hover: #202636;
  --bg-selected: #243044;
  --border: #2a3142;
  --text: #f4f6fb;
  --text-muted: #a7afc0;
  --text-dim: #697386;
  --accent: #3b82f6;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

* {
  box-sizing: border-box;
}

html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input,
textarea {
  font: inherit;
}

.ss-surface-interactive:hover {
  background: var(--bg-hover) !important;
  border-color: color-mix(in srgb, var(--accent), var(--border) 65%) !important;
}

.southstar-state-scroll {
  scrollbar-width: thin;
}
```

- [ ] **Step 7: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/web/southstar-board-contract.test.ts
npm test
```

Expected: type contract tests PASS. `app/page.tsx` intentionally renders the placeholder shell until Task 27 adds the migrated board component.

### Task 26: Southstar Web Local API And `/api/southstar/*` Routes

**Files:**
- Create: `lib/southstar/server-client.ts`
- Create: `lib/southstar/local-api.ts`
- Create: `app/api/southstar/projects/route.ts`
- Create: `app/api/southstar/projects/[projectId]/route.ts`
- Create: `app/api/southstar/projects/[projectId]/work-items/[workItemId]/route.ts`
- Create: `app/api/southstar/projects/[projectId]/work-items/[workItemId]/events/route.ts`
- Create: `app/api/southstar/projects/[projectId]/work-items/[workItemId]/actions/route.ts`
- Create: `app/api/southstar/watch/route.ts`
- Create: `tests/web/southstar-api-routes.test.ts`
- Modify: `tests/index.test.ts`
- Read/reference only: `/home/timmypai/apps/pi-web/lib/northstar/server-client.ts`
- Read/reference only: `/home/timmypai/apps/pi-web/lib/northstar/local-api-loader.js`
- Read/reference only: `/home/timmypai/apps/pi-web/app/api/northstar/**`

- [ ] **Step 1: Write local API test**

Create `tests/web/southstar-api-routes.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { createSouthstarLocalApi } from "../../lib/southstar/local-api.ts";

test("Southstar web local API reads in-repo config, store, and read model", () => {
  const root = mkdtempSync(join(tmpdir(), "southstar-web-api-"));
  const configPath = join(root, ".southstar.yaml");
  writeFileSync(configPath, `
schema_version: "0.1"
project:
  name: web-test
  root: ${root}
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 30
  lock_timeout_seconds: 300
  task_timeout_seconds: 3600
  max_retry_attempts: 2
intake:
  mode: local
sources:
  github:
    enabled: false
projection:
  github:
    enabled: false
    blocks_runtime: false
packs:
  search_paths: [packs]
workflow:
  id: generic_request_resolution
  version: "0.1"
  path: .southstar/workflows/generic-request-resolution.yaml
agents:
  path: .southstar/agents.yaml
`);
  const api = createSouthstarLocalApi({ configPath });
  const project = api.getProject();
  assert.equal(project.name, "web-test");
  assert.equal(project.configPath, configPath);
  assert.equal(project.runtimeDbPath.endsWith(".southstar/runtime/southstar.sqlite3"), true);
  assert.deepEqual(api.getBoard().groups.map((group) => group.runtimeStatus), [
    "ready",
    "active",
    "waiting",
    "exception",
    "completed",
    "failed",
    "quarantined",
    "cancelled",
  ]);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/web/southstar-api-routes.test.ts
```

Expected: FAIL because `createSouthstarLocalApi` does not exist.

- [ ] **Step 3: Implement in-repo local API**

Create `lib/southstar/local-api.ts`:

```ts
import { resolve } from "node:path";
import { loadConfig } from "../../src/config/load-config.ts";
import { SqliteSouthstarStore } from "../../src/runtime/store.ts";
import {
  buildSouthstarBoard,
  buildSouthstarWorkItemDetail,
  runEventForHistory,
  defaultSouthstarProjectCapabilities,
} from "../../src/operator-dashboard/read-model.ts";
import type { SouthstarBoard, SouthstarProjectSummary, SouthstarWorkItemDetail, SouthstarRunEvent } from "./types.ts";

export interface SouthstarLocalApi {
  getProject(): SouthstarProjectSummary;
  getBoard(): SouthstarBoard;
  getWorkItem(workItemId: string): SouthstarWorkItemDetail;
  listWorkItemEvents(workItemId: string): SouthstarRunEvent[];
  runWorkItemAction(request: Record<string, unknown>): Promise<unknown> | unknown;
}

export function createSouthstarLocalApi(input: { configPath: string }): SouthstarLocalApi {
  const readConfig = () => loadConfig(input.configPath);
  const projectSummary = (): SouthstarProjectSummary => {
    const config = readConfig();
    return {
      projectId: config.project.name,
      name: config.project.name,
      root: config.project.root,
      configPath: input.configPath,
      runtimeDbPath: resolve(config.project.root, config.runtime.dbPath),
      capabilities: defaultSouthstarProjectCapabilities,
    };
  };
  const readWithStore = <T>(read: (store: SqliteSouthstarStore) => T): T => {
    const project = projectSummary();
    const store = SqliteSouthstarStore.open(project.runtimeDbPath);
    try {
      return read(store);
    } finally {
      store.close();
    }
  };
  return {
    getProject: projectSummary,
    getBoard() {
      const project = projectSummary();
      return readWithStore((store) => buildSouthstarBoard({
        project,
        workItems: store.listWorkItems(),
        historiesByWorkItemId: store.listHistoriesByWorkItemId(store.listWorkItems().map((item) => item.id)),
        now: new Date().toISOString(),
      }));
    },
    getWorkItem(workItemId: string) {
      const project = projectSummary();
      return readWithStore((store) => buildSouthstarWorkItemDetail({
        project,
        workItem: store.getWorkItem(workItemId),
        tasks: store.listTasks(workItemId),
        history: store.listHistory(workItemId),
        now: new Date().toISOString(),
      }));
    },
    listWorkItemEvents(workItemId: string) {
      return readWithStore((store) => store.listHistory(workItemId).map(runEventForHistory));
    },
    runWorkItemAction(request: Record<string, unknown>) {
      return {
        status: "recorded",
        request,
      };
    },
  };
}
```

Add `listHistoriesByWorkItemId(workItemIds: string[])` to `SqliteSouthstarStore` before this step if Task 6 did not create it. Use one `SELECT ... WHERE work_item_id IN (...) ORDER BY work_item_id, sequence` query and return `Map<string, WorkItemHistoryEntry[]>`.

- [ ] **Step 4: Implement server client**

Create `lib/southstar/server-client.ts`:

```ts
import "server-only";

import { homedir } from "node:os";
import { resolve } from "node:path";
import { createSouthstarLocalApi, type SouthstarLocalApi } from "./local-api";

function resolveConfigPath(configPath: string): string {
  const trimmed = configPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export async function getSouthstarServerApi(request: Request): Promise<SouthstarLocalApi> {
  const url = new URL(request.url);
  const configPath = url.searchParams.get("config") ?? process.env.SOUTHSTAR_CONFIG;
  if (!configPath) throw new Error("SOUTHSTAR_CONFIG or ?config= is required");
  return createSouthstarLocalApi({ configPath: resolveConfigPath(configPath) });
}
```

- [ ] **Step 5: Implement API routes**

Create route files equivalent to the `pi-web` Northstar route shape but under `/api/southstar` and with work-item naming:

```ts
import { NextResponse } from "next/server";
import { getSouthstarServerApi } from "@/lib/southstar/server-client";

export async function GET(req: Request) {
  try {
    const api = await getSouthstarServerApi(req);
    return NextResponse.json({ projects: [api.getProject()] });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

For detail routes, use:

```ts
export async function GET(req: Request, context: { params: Promise<{ workItemId: string }> }) {
  try {
    const { workItemId } = await context.params;
    const api = await getSouthstarServerApi(req);
    return NextResponse.json({ workItem: api.getWorkItem(workItemId) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

Create `app/api/southstar/watch/route.ts`:

```ts
import { NextResponse } from "next/server";
import { runSouthstarWatchCycle, getSouthstarWatchStatus } from "@/src/runtime/watch";
import { getSouthstarServerApi } from "@/lib/southstar/server-client";

export async function GET(req: Request) {
  try {
    await getSouthstarServerApi(req);
    return NextResponse.json({ watch: getSouthstarWatchStatus() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const api = await getSouthstarServerApi(req);
    const body = (await req.json()) as { action?: string };
    if (body.action === "stop") return NextResponse.json({ watch: { status: "stopped" } });
    if (body.action !== "start") throw new Error("watch action must be start or stop");
    return NextResponse.json({ watch: await runSouthstarWatchCycle(api.getProject().configPath) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

`runSouthstarWatchCycle(configPath)` and `getSouthstarWatchStatus()` are exported by `src/runtime/watch.ts` in Task 20.

- [ ] **Step 6: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/web/southstar-api-routes.test.ts
npm test
```

Expected: PASS and no web API file imports from `/home/timmypai/apps/pi-web` or `../../../northstar`.

### Task 27: Migrate Board Components From `components/northstar` To `components/southstar`

**Files:**
- Create: `components/southstar/SouthstarBoard.tsx`
- Create: `components/southstar/WorkItemDrawer.tsx`
- Create: `components/southstar/WorkItemEventModal.tsx`
- Create: `components/southstar/WatchPanel.tsx`
- Create: `components/southstar/WorkspaceTabs.tsx`
- Create: `components/southstar/workspace-views.tsx`
- Create: `components/southstar/useWorkItemStream.ts`
- Create: `components/southstar/useWatchStream.ts`
- Create: `tests/web/southstar-board-component.test.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/index.test.ts`
- Read/reference only: `/home/timmypai/apps/pi-web/components/northstar/**`

- [ ] **Step 1: Write component helper tests**

Create `tests/web/southstar-board-component.test.tsx`:

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPath,
  countPending,
  isProblemCard,
  sortedCards,
} from "../../components/southstar/SouthstarBoard.tsx";
import type { SouthstarBoard, SouthstarBoardCard } from "../../lib/southstar/types.ts";

function card(input: Partial<SouthstarBoardCard>): SouthstarBoardCard {
  return {
    workItemId: input.workItemId ?? "wi_1",
    sourceRef: input.sourceRef ?? "local:wi_1",
    title: input.title ?? "Work item",
    runtimeStatus: input.runtimeStatus ?? "active",
    workflowState: input.workflowState ?? "analyzing",
    currentStage: input.currentStage ?? "analysis",
    latestHostAdapter: input.latestHostAdapter ?? "fake",
    dependencyCount: input.dependencyCount ?? 0,
    blocked: input.blocked ?? false,
    latestRootSessionId: input.latestRootSessionId ?? null,
    latestChildRunId: input.latestChildRunId ?? null,
    activeStreamAdapter: input.activeStreamAdapter ?? null,
    activeStreamSessionId: input.activeStreamSessionId ?? null,
    activeStreamChildRunId: input.activeStreamChildRunId ?? null,
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    nextRecommendedAction: input.nextRecommendedAction ?? "wait",
    projectionFailure: input.projectionFailure ?? false,
  };
}

test("apiPath targets Southstar routes", () => {
  assert.equal(
    apiPath("/api/southstar/projects", "/tmp/app/.southstar.yaml"),
    "/api/southstar/projects?config=%2Ftmp%2Fapp%2F.southstar.yaml",
  );
});

test("pending count uses Southstar runtime statuses", () => {
  const board: SouthstarBoard = {
    project: {
      projectId: "p",
      name: "p",
      root: "/tmp/p",
      configPath: "/tmp/p/.southstar.yaml",
      runtimeDbPath: "/tmp/p/.southstar/runtime/southstar.sqlite3",
      capabilities: { hostAdapters: ["fake"], optionalParameters: [], mcpServers: { status: "design_only", configurable: false, supported: false } },
    },
    groups: [
      { runtimeStatus: "ready", cards: [card({ workItemId: "wi_ready", runtimeStatus: "ready" })] },
      { runtimeStatus: "active", cards: [card({ workItemId: "wi_active", runtimeStatus: "active" })] },
      { runtimeStatus: "completed", cards: [card({ workItemId: "wi_done", runtimeStatus: "completed" })] },
    ],
  };
  assert.equal(countPending(board), 2);
});

test("problem sorting prioritizes failed and exception work items", () => {
  const sorted = sortedCards([
    card({ workItemId: "wi_ok", runtimeStatus: "active" }),
    card({ workItemId: "wi_failed", runtimeStatus: "failed" }),
    card({ workItemId: "wi_exception", runtimeStatus: "exception" }),
  ]);
  assert.deepEqual(sorted.map((item) => item.workItemId), ["wi_failed", "wi_exception", "wi_ok"]);
  assert.equal(isProblemCard(card({ runtimeStatus: "quarantined" })), "red");
  assert.equal(isProblemCard(card({ runtimeStatus: "exception" })), "orange");
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/web/southstar-board-component.test.tsx
```

Expected: FAIL because `components/southstar/SouthstarBoard.tsx` does not exist.

- [ ] **Step 3: Copy and rename board components**

Copy the relevant `pi-web/components/northstar/*` component logic into `components/southstar/*` with these required renames:

| pi-web source | Southstar target |
| --- | --- |
| `NorthstarBoard.tsx` | `SouthstarBoard.tsx` |
| `IssueDrawer.tsx` | `WorkItemDrawer.tsx` |
| `IssueSseModal.tsx` | `WorkItemEventModal.tsx` |
| `WatchSsePanel.tsx` | `WatchPanel.tsx` |
| `useIssueStream.ts` | `useWorkItemStream.ts` |
| `usePiSessionSse.ts` | `useWatchStream.ts` |
| `/api/northstar/*` | `/api/southstar/*` |
| `.northstar.yaml` | `.southstar.yaml` |
| `issueId` | `workItemId` |
| `issueNumber` | `sourceRef` or pack-specific link |
| `lifecycle` | `runtimeStatus` |

Export the pure helpers used by the test from `SouthstarBoard.tsx`:

```ts
export function apiPath(path: string, configPath: string): string {
  return `${path}?config=${encodeURIComponent(configPath)}`;
}

export function isProblemCard(card: SouthstarBoardCard): "red" | "orange" | null {
  if (card.runtimeStatus === "quarantined" || card.runtimeStatus === "failed") return "red";
  if (card.runtimeStatus === "exception") return "orange";
  if (card.blocked || card.projectionFailure) return "orange";
  return null;
}

export function sortedCards(cards: SouthstarBoardCard[]): SouthstarBoardCard[] {
  return [...cards].sort((a, b) => {
    const pa = isProblemCard(a) === "red" ? 0 : isProblemCard(a) === "orange" ? 1 : 2;
    const pb = isProblemCard(b) === "red" ? 0 : isProblemCard(b) === "orange" ? 1 : 2;
    return pa - pb;
  });
}

export function countPending(board: SouthstarBoard): number {
  const counts = new Map(board.groups.map((group) => [group.runtimeStatus, group.cards.length]));
  return (["ready", "active", "waiting", "exception"] as const).reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
}
```

- [ ] **Step 4: Adapt actions**

In `WorkItemDrawer.tsx`, replace Northstar issue actions with generic Southstar operator actions:

```ts
type WorkItemActionCommand = "start" | "reconcile" | "retry" | "resume" | "cancel" | "quarantine";

function actionsForCard(card: SouthstarBoardCard): Array<{ label: string; command: WorkItemActionCommand }> {
  if (card.runtimeStatus === "ready") return [{ label: "Start", command: "start" }];
  if (card.runtimeStatus === "active" || card.runtimeStatus === "waiting" || card.runtimeStatus === "exception") return [{ label: "Reconcile", command: "reconcile" }];
  if (card.runtimeStatus === "quarantined") return [{ label: "Resume", command: "resume" }];
  if (card.runtimeStatus === "failed") return [{ label: "Retry", command: "retry" }];
  return [];
}
```

Action POST target:

```ts
`/api/southstar/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(card.workItemId)}/actions?config=${encodeURIComponent(configPath)}`
```

- [ ] **Step 5: Adapt watch behavior**

Replace Pi chat-session watch prompts with Southstar watch endpoints:

- start: `POST /api/southstar/watch?config=<path>` with `{ action: "start" }`
- stop: `POST /api/southstar/watch?config=<path>` with `{ action: "stop" }`
- status polling: `GET /api/southstar/watch?config=<path>`

The first implementation uses status polling plus manual refresh. Do not keep Pi chat-session prompts, `/api/agent/new`, or `/api/agent/[id]` calls in the Southstar board.

- [ ] **Step 6: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/web/southstar-board-component.test.tsx
npm test
```

Expected: PASS. Source scan shows no `Northstar`, `/api/northstar`, `.northstar.yaml`, `issueId`, or `lifecycle` in `components/southstar`, `lib/southstar`, or `app/api/southstar`.

### Task 28: Web Build And Browser Smoke Verification

**Files:**
- Modify: `package.json`
- Create: `tests/fixtures/southstar/web/runtime-db.ts`
- Verify: `app/page.tsx`
- Verify: `app/api/southstar/**`
- Verify: `components/southstar/**`

- [ ] **Step 1: Create fixture runtime DB helper**

Create `tests/fixtures/southstar/web/runtime-db.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteSouthstarStore } from "../../../../src/runtime/store.ts";

export function createWebBoardFixture(root: string): string {
  const dbPath = join(root, ".southstar/runtime/southstar.sqlite3");
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = SqliteSouthstarStore.open(dbPath);
  try {
    store.createWorkItem({
      id: "wi_web_ready",
      domain: "custom",
      work_type: "request",
      source_provider: "local",
      source_ref: "local:wi_web_ready",
      title: "Ready web board item",
      runtime_status: "ready",
      workflow_state: "analyzing",
      workflow_id: "generic_request_resolution",
      workflow_version: "0.1",
      workflow_fingerprint: "sha256:web",
      current_stage: "analysis",
      current_stage_attempt: 0,
      priority: 0,
      projection_json: {},
      workflow_json: {},
      state_json: {},
      snapshot_json: {},
    });
    store.createWorkItem({
      id: "wi_web_exception",
      domain: "custom",
      work_type: "request",
      source_provider: "local",
      source_ref: "local:wi_web_exception",
      title: "Exception web board item",
      runtime_status: "exception",
      workflow_state: "analyzing",
      workflow_id: "generic_request_resolution",
      workflow_version: "0.1",
      workflow_fingerprint: "sha256:web",
      current_stage: "analysis",
      current_stage_attempt: 1,
      priority: 0,
      projection_json: {},
      workflow_json: {},
      state_json: {},
      snapshot_json: {},
    });
  } finally {
    store.close();
  }
  return dbPath;
}
```

- [ ] **Step 2: Verify Next build**

Run:

```bash
npm run web:build
```

Expected: Next production build succeeds. It must not report module resolution errors for `@/lib/southstar/*`, `@/components/southstar/*`, or `../../src/*`.

- [ ] **Step 3: Start dev server**

Run:

```bash
npm run web:dev
```

Expected: dev server starts on `http://localhost:3030`. If port 3030 is already in use, run `npm run web:dev -- -p 3031 --webpack` and use `http://localhost:3031` for the next step.

- [ ] **Step 4: Browser smoke with fixture config**

Create a temporary fixture project:

```bash
mkdir -p /tmp/southstar-web-fixture/.southstar
cat > /tmp/southstar-web-fixture/.southstar.yaml <<'YAML'
schema_version: "0.1"
project:
  name: southstar-web-fixture
  root: /tmp/southstar-web-fixture
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 30
  lock_timeout_seconds: 300
  task_timeout_seconds: 3600
  max_retry_attempts: 2
intake:
  mode: local
sources:
  github:
    enabled: false
projection:
  github:
    enabled: false
    blocks_runtime: false
packs:
  search_paths: [packs]
workflow:
  id: generic_request_resolution
  version: "0.1"
  path: .southstar/workflows/generic-request-resolution.yaml
agents:
  path: .southstar/agents.yaml
YAML
npx tsx -e "import('./tests/fixtures/southstar/web/runtime-db.ts').then((m)=>m.createWebBoardFixture('/tmp/southstar-web-fixture'))"
```

Open:

```text
http://localhost:3030/?config=/tmp/southstar-web-fixture/.southstar.yaml
```

Expected browser-visible evidence:

- page title is `Southstar`.
- board header shows `southstar-web-fixture`.
- at least two cards render: `Ready web board item` and `Exception web board item`.
- columns are Southstar runtime statuses, including `ready` and `exception`.
- opening the exception card shows the work item drawer.
- no visible text says `Northstar`, `.northstar.yaml`, `issue`, or `lifecycle`.

- [ ] **Step 5: Screenshot and console verification**

Use the Browser plugin or Playwright to capture a desktop screenshot and inspect console errors:

```bash
npx playwright screenshot "http://localhost:3030/?config=/tmp/southstar-web-fixture/.southstar.yaml" /tmp/southstar-board.png
```

Expected: screenshot is nonblank and shows the Southstar board. Browser console has no uncaught runtime errors. Warnings from development tooling are acceptable only if the board renders and API calls succeed.

- [ ] **Step 6: Stop dev server**

Stop the `npm run web:dev` session before finishing the task.

---

## Phase 7: Final Coverage And Verification

### Task 29: Final Acceptance Matrix And Verification

**Files:**
- Create: `docs/superpowers/southstar-dynamic-workflow-runtime-coverage.md`
- Modify: `tests/index.test.ts`
- Modify as needed: `package.json`

- [ ] **Step 1: Create coverage matrix**

Create `docs/superpowers/southstar-dynamic-workflow-runtime-coverage.md`:

```md
# Southstar Dynamic Workflow Runtime Coverage

Source spec: `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md`

| Acceptance | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-01 | Local SQLite work item with no external credentials | `tests/runtime/work-items.test.ts`, `tests/cli/southstar-cli.test.ts` | `src/runtime/work-items.ts`, `src/runtime/store.ts`, `src/cli/work-command.ts` |
| AC-02 | Pack lint/explain validates assets | `tests/packs/pack-lint-explain.test.ts`, `tests/packs/software-delivery-pack.test.ts`, `tests/packs/starter-packs.test.ts` | `src/packs/loader.ts`, `src/packs/lint.ts`, `src/packs/explain.ts` |
| AC-03 | Immutable resolved workflow snapshot | `tests/packs/pack-lint-explain.test.ts` | `src/packs/resolver.ts`, `src/agents/catalog.ts`, `src/runtime/artifact-registry.ts` |
| AC-04 | Workflow state maps to fixed runtime status | `tests/workflows/workflow-validation.test.ts` | `src/workflows/parser.ts`, `src/types/runtime.ts` |
| AC-05 | Stage root session row | `tests/runtime/evaluator.test.ts`, `tests/runtime/store.test.ts` | `src/runtime/evaluator.ts`, `src/runtime/store.ts` |
| AC-06 | Task child/subagent run row and session ids | `tests/adapters/host-dispatcher.test.ts` | `src/runtime/dispatcher.ts`, `src/adapters/host/types.ts` |
| AC-07 | Artifact stored on task row with query columns | `tests/runtime/evaluator-artifacts.test.ts`, `tests/runtime/store.test.ts` | `src/runtime/evaluator.ts`, `src/runtime/store.ts` |
| AC-08 | Artifact validates before policy use | `tests/runtime/artifact-registry.test.ts`, `tests/runtime/evaluator-artifacts.test.ts` | `src/runtime/artifact-registry.ts`, `src/runtime/evaluator.ts` |
| AC-09 | Rejected artifacts audited only | `tests/runtime/artifact-registry.test.ts`, `tests/runtime/evaluator-artifacts.test.ts` | `src/runtime/artifact-registry.ts`, `src/runtime/evaluator.ts` |
| AC-10 | Component boundaries testable | `tests/runtime/scheduler.test.ts`, `tests/runtime/evaluator.test.ts`, `tests/adapters/host-dispatcher.test.ts`, `tests/adapters/source-projection.test.ts`, `tests/operator-dashboard/read-model.test.ts` | `src/runtime/*`, `src/adapters/*`, `src/operator-dashboard/*` |
| AC-11 | Routing branches on artifact field | `tests/runtime/policy.test.ts` | `src/runtime/policy.ts`, `src/runtime/evaluator.ts` |
| AC-12 | Completion policy advances graph | `tests/runtime/policy.test.ts`, `tests/workflows/workflow-simulate.test.ts` | `src/runtime/policy.ts`, `src/workflows/simulate.ts` |
| AC-13 | Exception policy separate from routing | `tests/runtime/exception-policy.test.ts` | `src/runtime/policy.ts`, `src/runtime/evaluator.ts` |
| AC-14 | Duplicate starts do not duplicate task runs | `tests/runtime/race-idempotency.test.ts` | `src/runtime/store.ts`, `src/runtime/evaluator.ts`, `src/runtime/watch.ts` |
| AC-15 | Non-blocking projection failure does not block runtime | `tests/adapters/source-projection.test.ts` | `src/runtime/projection-worker.ts`, `src/adapters/projection/*` |
| AC-16 | Workflow skill generates assets and review commands | `tests/skills/southstar-workflow-authoring.test.ts` | `skills/southstar/**` |
| AC-17 | Software delivery pack installable; core runnable without it | `tests/packs/software-delivery-pack.test.ts`, `tests/packs/starter-packs.test.ts` | `packs/software_delivery/**`, `src/packs/*` |
| AC-18 | Southstar repo contains migrated web board, no external pi-web dependency | `tests/web/southstar-board-contract.test.ts`, source scans | `app/**`, `components/southstar/**`, `lib/southstar/**` |
| AC-19 | `/api/southstar/*` routes read Southstar in-repo config/store/read model | `tests/web/southstar-api-routes.test.ts` | `app/api/southstar/**`, `lib/southstar/local-api.ts`, `lib/southstar/server-client.ts` |
| AC-20 | Board UI uses Southstar work item/runtime vocabulary | `tests/web/southstar-board-component.test.tsx`, source scans | `components/southstar/**`, `lib/southstar/types.ts` |
| AC-21 | Web board is browser verified | browser smoke, screenshot, `npm run web:build` | `app/**`, `components/southstar/**`, `app/api/southstar/**` |
```

- [ ] **Step 2: Run full offline gate**

Run:

```bash
npm test
npm run web:build
```

Expected: PASS.

- [ ] **Step 3: Run focused source scans**

Run:

```bash
rg "Northstar|northstar|IssueSnapshot|issue_history|runtime_context_json|release_pending|pull_request|pr_number" src tests --glob '!tests/packs/**' --glob '!src/adapters/source/github.ts' --glob '!src/adapters/projection/github.ts'
rg "Northstar|northstar|\\.northstar|issueId|lifecycle|/api/northstar" app components/southstar lib/southstar tests/web
rg "process\\.env\\." src
rg "&&|\\|\\||;" src skills/southstar --glob '*.ts' --glob '*.mjs'
```

Expected:

- first command has no output except allowed software-delivery pack/source/projection files.
- second command has no output.
- third command shows only `SOUTHSTAR_CONFIG`, `SOUTHSTAR_PROJECT_ROOT`, or `SOUTHSTAR_DEBUG`.
- fourth command has no shell-chain command construction matches. Literal semicolons in TypeScript syntax are acceptable; investigate only command string construction.

- [ ] **Step 4: Verify CLI smoke**

Run:

```bash
npm run southstar -- --help
npm run southstar -- doctor --config tests/fixtures/southstar/config/.southstar.yaml
npm run southstar -- workflow lint tests/fixtures/southstar/workflows/generic-request-resolution.yaml
npm run southstar -- pack explain packs/software_delivery
npm run web:build
```

Expected:

- help lists Southstar commands.
- doctor reports local mode can run without external credentials.
- workflow lint exits successfully.
- pack explain includes Software Delivery work types, workflows, artifacts, source/projection mappings, and operational risks.
- web build completes successfully.

- [ ] **Step 5: Final git checkpoint when git is usable**

Run:

```bash
git status --short
git add package.json package-lock.json src tests packs skills docs/superpowers/southstar-dynamic-workflow-runtime-coverage.md
git commit -m "feat: implement southstar dynamic workflow runtime"
```

Expected: commit succeeds in a valid git workspace. If the workspace has no usable git metadata, record the full `git status` error and provide the changed file list instead.

## Self-Review Checklist

- [ ] Every requirement in `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md` maps to an acceptance criterion or explicit phase task in this plan.
- [ ] Southstar core uses generic names: `work_item`, `stage`, `task`, `artifact`, `policy`, `session`, `source`, `projection`.
- [ ] Software delivery terms appear only in pack assets, source/projection adapters, or software-delivery pack tests.
- [ ] Three-table runtime schema is preserved.
- [ ] Workflow state is separate from fixed runtime status.
- [ ] Normal routing, completion, and exception/recovery semantics are separate.
- [ ] Race/idempotency requirements have dedicated tests.
- [ ] Workflow skill produces design spec and assets, validates with lint/explain/simulate, and asks before writing.
- [ ] `npm test` is the default offline gate and does not require external credentials.
