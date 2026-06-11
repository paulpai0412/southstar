# Northstar Pi Host Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pi as a production host while passing role metadata and capability reports consistently through Codex, OpenCode, and Pi workers.

**Architecture:** Introduce shared host capability/request types, extend config and worker selection to `pi`, propagate role context from the domain driver into every SDK worker, and add a Pi SDK worker that uses `@earendil-works/pi-coding-agent` directly. MCP is represented only as a capability vocabulary value in this implementation; no worker configures MCP servers.

**Tech Stack:** Node 22 TypeScript ESM, `node:test`, existing Northstar workflow/runtime types, Codex SDK optional dependency, OpenCode SDK optional dependency, Pi SDK optional dependency through dynamic import.

---

## Source Spec

Read before implementing:

- `docs/superpowers/specs/2026-06-01-northstar-pi-host-capability-design.md`
- `src/types/workflow.ts`
- `src/orchestrator/software-dev-driver.ts`
- `src/adapters/host/worker-factory.ts`
- `src/adapters/host/codex-worker.ts`
- `src/adapters/host/opencode-worker.ts`
- `src/adapters/host/sdk-loaders.ts`
- `src/config/schema.ts`

## File Structure

Create:

- `src/adapters/host/capabilities.ts`  
  Shared production host names, capability vocabulary, capability report helpers, model reference parsing, and default report builders.

- `src/adapters/host/pi-worker.ts`  
  Pi production `SoftwareDevWorker` implementation using `@earendil-works/pi-coding-agent` SDK primitives only.

Modify:

- `src/types/host.ts`  
  Add optional capability report on host child run result.

- `src/types/control-plane.ts`  
  Allow child runs to store optional capability reports for audit.

- `src/runtime/state-machine.ts`  
  Carry optional capability reports from `start_stage` events into child runs.

- `src/runtime/engine.ts`  
  Pass optional capability reports from host child results to the start-stage event.

- `src/orchestrator/host-dispatch.ts`  
  Preserve optional capability report on dispatch result child runs.

- `src/orchestrator/software-dev-driver.ts`  
  Add role context and timeout fields to worker inputs, propagate role metadata, enqueue capability reports, and use role timeouts.

- `src/adapters/host/codex-worker.ts`  
  Accept role metadata, use role timeout, and emit capability report.

- `src/adapters/host/opencode-worker.ts`  
  Accept role metadata, use role timeout, pass role agent into OpenCode session create, and emit capability report.

- `src/adapters/host/worker-factory.ts`  
  Add `pi` as a production host and worker factory target.

- `src/adapters/host/sdk-loaders.ts`  
  Add Pi package-name and dynamic import loader.

- `src/config/schema.ts`  
  Add `pi` to host adapter names and credentials host SDK config.

- `src/orchestrator/production-dependencies.ts`  
  Wire the Pi worker into default production dependencies and test injection.

- `package.json` and `package-lock.json`  
  Add `@earendil-works/pi-coding-agent` as an optional dependency.

- `tests/fixtures/.northstar.yaml`  
  Include `credentials.host_sdk.pi.mode`.

Tests:

- `tests/adapters/sdk-workers.test.ts`
- `tests/adapters/host-worker-factory.test.ts`
- `tests/adapters/adapters.test.ts`
- `tests/config/load-config.test.ts`
- `tests/orchestrator/software-dev-driver.test.ts`
- `tests/orchestrator/production-dependencies.test.ts`
- `tests/index.test.ts`

---

### Task 1: Shared Host Capability Types And Loader Boundary

**Files:**
- Create: `src/adapters/host/capabilities.ts`
- Modify: `src/adapters/host/sdk-loaders.ts`
- Modify: `tests/adapters/sdk-workers.test.ts`
- Modify: `tests/adapters/adapters.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing tests for capability helpers and Pi loader**

Append to `tests/adapters/sdk-workers.test.ts`:

```ts
import {
  buildCapabilityReport,
  parseHostModelReference,
  productionHostNames,
} from "../../src/adapters/host/capabilities.ts";
import { piSdkPackageName, piLoader } from "../../src/adapters/host/sdk-loaders.ts";

test("host capability helpers normalize model references and reports", () => {
  assert.deepEqual(productionHostNames, ["codex", "opencode", "pi"]);
  assert.deepEqual(parseHostModelReference(undefined), undefined);
  assert.deepEqual(parseHostModelReference("gpt-5"), { modelId: "gpt-5" });
  assert.deepEqual(parseHostModelReference("openai/gpt-5"), { provider: "openai", modelId: "gpt-5" });
  assert.deepEqual(buildCapabilityReport({
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills", "mcp_servers"],
  }), {
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills", "mcp_servers"],
  });
});

test("pi SDK loader pins concrete package name behind dynamic import boundary", () => {
  assert.equal(piSdkPackageName(), "@earendil-works/pi-coding-agent");
  assert.match(piLoader.toString(), /import\("@earendil-works\/pi-coding-agent"\)/);
});
```

Extend the existing loader test in `tests/adapters/adapters.test.ts`:

```ts
import { piLoader, piSdkPackageName } from "../../src/adapters/host/sdk-loaders.ts";

test("host SDK loaders include pi package behind dynamic import boundaries", () => {
  assert.equal(piSdkPackageName(), "@earendil-works/pi-coding-agent");
  assert.match(piLoader.toString(), /import\("@earendil-works\/pi-coding-agent"\)/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/adapters.test.ts
```

Expected: both commands fail because `capabilities.ts`, `piSdkPackageName`, and `piLoader` do not exist.

- [ ] **Step 3: Add shared capability helpers**

Create `src/adapters/host/capabilities.ts`:

```ts
import type { RoleDefinition } from "../../types/workflow.ts";

export const productionHostNames = ["codex", "opencode", "pi"] as const;
export type ProductionHostName = typeof productionHostNames[number];

export const hostCapabilityNames = [
  "agent",
  "model",
  "load_skills",
  "tools",
  "reasoning_effort",
  "mcp_servers",
] as const;
export type HostCapabilityName = typeof hostCapabilityNames[number];

export interface HostCapabilityReport {
  host: ProductionHostName;
  applied: HostCapabilityName[];
  defaulted: HostCapabilityName[];
  unsupported: HostCapabilityName[];
}

export interface HostExecutionContext {
  prompt: string;
  working_directory: string;
  issue_number?: number;
  issue_url?: string;
  repo?: string;
  branch?: string;
  pr_number?: number;
  pr_url?: string;
}

export interface HostExecutionRequest {
  host: ProductionHostName;
  role_name: string;
  role: RoleDefinition;
  execution: HostExecutionContext;
}

export interface HostModelReference {
  provider?: string;
  modelId: string;
}

export function isProductionHostName(value: string): value is ProductionHostName {
  return (productionHostNames as readonly string[]).includes(value);
}

export function buildCapabilityReport(input: {
  host: ProductionHostName;
  applied?: HostCapabilityName[];
  defaulted?: HostCapabilityName[];
  unsupported?: HostCapabilityName[];
}): HostCapabilityReport {
  return {
    host: input.host,
    applied: uniqueCapabilities(input.applied ?? []),
    defaulted: uniqueCapabilities(input.defaulted ?? []),
    unsupported: uniqueCapabilities(input.unsupported ?? []),
  };
}

export function parseHostModelReference(value: string | undefined): HostModelReference | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { modelId: value };
  return {
    provider: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

function uniqueCapabilities(values: HostCapabilityName[]): HostCapabilityName[] {
  return [...new Set(values)];
}
```

- [ ] **Step 4: Add the Pi loader**

Modify `src/adapters/host/sdk-loaders.ts`:

```ts
export function opencodeSdkPackageName(): "@opencode-ai/sdk" {
  return "@opencode-ai/sdk";
}

export function codexSdkPackageName(): "@openai/codex-sdk" {
  return "@openai/codex-sdk";
}

export function piSdkPackageName(): "@earendil-works/pi-coding-agent" {
  return "@earendil-works/pi-coding-agent";
}

export async function openCodeLoader(): Promise<unknown> {
  return import("@opencode-ai/sdk");
}

export async function codexLoader(): Promise<unknown> {
  return import("@openai/codex-sdk");
}

export async function piLoader(): Promise<unknown> {
  return import("@earendil-works/pi-coding-agent");
}
```

- [ ] **Step 5: Add Pi optional dependency**

Run:

```bash
npm install --package-lock-only --save-optional @earendil-works/pi-coding-agent@^0.78.0
```

Expected: `package.json` contains this optional dependency:

```json
"@earendil-works/pi-coding-agent": "^0.78.0"
```

If the command cannot reach the npm registry, request sandbox escalation for this command and rerun it.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/adapters.test.ts
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/adapters/host/capabilities.ts src/adapters/host/sdk-loaders.ts tests/adapters/sdk-workers.test.ts tests/adapters/adapters.test.ts package.json package-lock.json
git commit -m "feat: add host capability primitives"
```

---

### Task 2: Config And Worker Factory Support For Pi

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/adapters/host/worker-factory.ts`
- Modify: `tests/config/load-config.test.ts`
- Modify: `tests/adapters/host-worker-factory.test.ts`
- Modify: `tests/fixtures/.northstar.yaml`

- [ ] **Step 1: Write failing config tests for Pi**

In `tests/config/load-config.test.ts`, update the fixture assertion:

```ts
assert.equal(config.credentials?.hostSdk.pi.mode, "sdk_default");
```

Update the unknown-host test expected message:

```ts
/runtime.host_adapter must be codex, opencode, or pi/
```

Add this test:

```ts
test("runtime config accepts pi host adapter and credentials", () => {
  const config = validateRuntimeConfig(baseConfig({
    runtime: {
      host_adapter: "pi",
    },
    credentials: {
      host_sdk: {
        pi: { mode: "sdk_default" },
      },
    },
  }));

  assert.equal(config.runtime.hostAdapter, "pi");
  assert.equal(config.credentials?.hostSdk.pi.mode, "sdk_default");
});
```

Add this assertion to the existing invalid credentials test block:

```ts
assert.throws(
  () => validateRuntimeConfig(baseConfig({ credentials: { host_sdk: { pi: { mode: "cli" } } } })),
  /credentials.host_sdk.pi.mode must be sdk_default/,
);
```

- [ ] **Step 2: Write failing worker factory tests for Pi**

Replace `tests/adapters/host-worker-factory.test.ts` with:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { HostWorkerFactory } from "../../src/adapters/host/worker-factory.ts";
import type { ProductionHostName } from "../../src/adapters/host/capabilities.ts";
import type { SoftwareDevWorker } from "../../src/orchestrator/software-dev-driver.ts";

test("role host resolver uses global default and role override for all production hosts", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "pi",
    roleOverrides: {
      issue_worker: { host_adapter: "codex" },
      pr_verifier: { host_adapter: "opencode" },
    },
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
    piWorker: () => fakeWorker("pi"),
  });

  assert.equal(resolver.resolveHostForRole("release_worker"), "pi");
  assert.equal(resolver.resolveHostForRole("issue_worker"), "codex");
  assert.equal(resolver.resolveHostForRole("pr_verifier"), "opencode");
  assert.equal(resolver.workerForRole("release_worker").kind, "pi");
});

test("role host resolver rejects unknown host", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "codex",
    roleOverrides: {
      issue_worker: { host_adapter: "bad" },
    },
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
    piWorker: () => fakeWorker("pi"),
  });

  assert.throws(() => resolver.workerForRole("issue_worker"), /HOST_ADAPTER_UNKNOWN/);
});

function fakeWorker(kind: ProductionHostName): SoftwareDevWorker & { kind: ProductionHostName } {
  return {
    kind,
    async runImplementation() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
    async runVerification() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
  };
}
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/host-worker-factory.test.ts
```

Expected: config rejects `pi`, credentials lack `pi`, and `HostWorkerFactory` lacks `piWorker`.

- [ ] **Step 4: Extend config schema**

Modify `src/config/schema.ts`.

Import the shared host type:

```ts
import { isProductionHostName, type ProductionHostName } from "../adapters/host/capabilities.ts";
```

Change credentials and host type:

```ts
export type HostAdapterName = ProductionHostName;
```

```ts
hostSdk: {
  codex: { mode: "sdk_default" };
  opencode: { mode: "sdk_default" };
  pi: { mode: "sdk_default" };
};
```

Change host validation:

```ts
const hostAdapter = stringField(value, "runtime.host_adapter");
if (!isProductionHostName(hostAdapter)) {
  throw new Error("runtime.host_adapter must be codex, opencode, or pi");
}
```

Change credentials normalization:

```ts
hostSdk: {
  codex: { mode: normalizeSdkMode(value, "credentials.host_sdk.codex.mode") },
  opencode: { mode: normalizeSdkMode(value, "credentials.host_sdk.opencode.mode") },
  pi: { mode: normalizeSdkMode(value, "credentials.host_sdk.pi.mode") },
},
```

- [ ] **Step 5: Extend fixture credentials**

Modify `tests/fixtures/.northstar.yaml`:

```yaml
credentials:
  github:
    token_env: GITHUB_TOKEN
    allow_gh_token_fallback: true
  host_sdk:
    codex:
      mode: sdk_default
    opencode:
      mode: sdk_default
    pi:
      mode: sdk_default
```

- [ ] **Step 6: Extend worker factory**

Modify `src/adapters/host/worker-factory.ts`:

```ts
import { isProductionHostName, type ProductionHostName } from "./capabilities.ts";
import type { SoftwareDevWorker } from "../../orchestrator/software-dev-driver.ts";

export class HostWorkerFactory {
  readonly input: {
    defaultHost: ProductionHostName;
    roleOverrides: Record<string, Record<string, unknown>>;
    codexWorker: () => SoftwareDevWorker;
    opencodeWorker: () => SoftwareDevWorker;
    piWorker: () => SoftwareDevWorker;
  };

  constructor(input: {
    defaultHost: ProductionHostName;
    roleOverrides: Record<string, Record<string, unknown>>;
    codexWorker: () => SoftwareDevWorker;
    opencodeWorker: () => SoftwareDevWorker;
    piWorker: () => SoftwareDevWorker;
  }) {
    this.input = input;
  }

  resolveHostForRole(roleName: string): ProductionHostName {
    const override = this.input.roleOverrides[roleName]?.host_adapter;
    const host = typeof override === "string" ? override : this.input.defaultHost;
    if (!isProductionHostName(host)) {
      throw new Error(`HOST_ADAPTER_UNKNOWN: ${host}`);
    }
    return host;
  }

  workerForRole(roleName: string): SoftwareDevWorker {
    const host = this.resolveHostForRole(roleName);
    if (host === "pi") return this.input.piWorker();
    if (host === "opencode") return this.input.opencodeWorker();
    return this.input.codexWorker();
  }
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/host-worker-factory.test.ts
```

Expected: both commands pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/config/schema.ts src/adapters/host/worker-factory.ts tests/config/load-config.test.ts tests/adapters/host-worker-factory.test.ts tests/fixtures/.northstar.yaml
git commit -m "feat: support pi host selection"
```

---

### Task 3: Propagate Role Context, Role Timeout, And Capability Reports Through Production Driver

**Files:**
- Modify: `src/types/host.ts`
- Modify: `src/types/control-plane.ts`
- Modify: `src/runtime/state-machine.ts`
- Modify: `src/runtime/engine.ts`
- Modify: `src/orchestrator/host-dispatch.ts`
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `tests/orchestrator/software-dev-driver.test.ts`
- Modify: `tests/runtime/state-machine.test.ts`

- [ ] **Step 1: Write failing tests for role context and capability persistence**

Append to `tests/orchestrator/software-dev-driver.test.ts`:

```ts
test("software-dev driver passes role context and role timeout to implementation worker", async () => {
  const host = new QueuedHostSessionBridge();
  const seen: Array<{ roleName?: string; roleAgent?: string; timeoutMs?: number; worktree?: string }> = [];
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "pi",
    runId: "role-context",
    github: new RecordingGitHub(),
    worker: {
      async runImplementation(input) {
        seen.push({
          roleName: input.role_name,
          roleAgent: input.role?.agent,
          timeoutMs: input.timeout_ms,
          worktree: input.worktree_path,
        });
        return {
          root_session_id: "pi-root",
          child_run_id: "pi-child",
          session_id: "pi-session",
          final_response: "implemented",
          shell_fallbacks: 0,
          capability_report: {
            host: "pi",
            applied: ["model"],
            defaulted: ["agent"],
            unsupported: ["load_skills"],
          },
        };
      },
      async runVerification() {
        throw new Error("verification not needed for this test");
      },
    },
    host,
    metrics: emptyMetrics(),
    baseBranch: "main",
    worktree: {
      async prepareIssueWorktree() {
        return { path: "/repo/.northstar/runtime/worktrees/issue-42", branch: "northstar/42" };
      },
      async commitAndPush() {
        return { commit_sha: "commit-1" };
      },
    },
  });

  await driver.prepareStage(domainContext({
    roleName: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 11,
    },
  }));
  const root = host.startRootSession({
    issue_id: "github:42",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 11,
    },
  });
  const child = host.startBackgroundChild({
    issue_id: "github:42",
    lease_id: "lease-42",
    root_session_id: root.root_session_id,
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 11,
    },
  });

  assert.deepEqual(seen, [{
    roleName: "issue_worker",
    roleAgent: "build",
    timeoutMs: 11_000,
    worktree: "/repo/.northstar/runtime/worktrees/issue-42",
  }]);
  assert.deepEqual(child.capability_report?.unsupported, ["load_skills"]);
});
```

Use the existing `RecordingGitHub`, `emptyMetrics`, and `domainContext` helpers already present in this test file.

Append to `tests/runtime/state-machine.test.ts`:

```ts
test("start stage records optional host capability report on child run", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("42", { lifecycle_state: "claimed", owner_lease: lease() }),
    workflow(),
    [{
      type: "start_stage",
      child_run_id: "child-capability-1",
      session_id: "session-capability-1",
      at: now,
      capability_report: {
        host: "pi",
        applied: ["model"],
        defaulted: ["agent"],
        unsupported: ["load_skills", "mcp_servers"],
      },
    }],
  );

  assert.deepEqual(result.snapshot.runtime_context_json.child_runs?.[0]?.capability_report, {
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills", "mcp_servers"],
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/state-machine.test.ts
```

Expected: tests fail because worker inputs do not include role context, the bridge does not carry capability reports, and `start_stage` does not persist the report.

- [ ] **Step 3: Extend host and control-plane types**

Modify `src/types/host.ts`:

```ts
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
import type { RoleDefinition } from "./workflow.ts";

export interface HostChildRunResult {
  child_run_id: string;
  root_session_id: string;
  session_id: string;
  status: "running";
  agent: string;
  load_skills: string[];
  capability_report?: HostCapabilityReport;
}
```

Modify `src/types/control-plane.ts`:

```ts
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";

export interface ChildRun {
  child_run_id: string;
  lease_id: string;
  root_session_id: string;
  role: string;
  status: ChildRunStatus;
  session_id: string;
  started_at: string;
  last_seen_at: string;
  artifact_history_id?: number;
  capability_report?: HostCapabilityReport;
}
```

- [ ] **Step 4: Extend start-stage event**

Modify the runtime event union in `src/runtime/state-machine.ts`:

```ts
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
```

```ts
| {
    type: "start_stage";
    child_run_id: string;
    session_id: string;
    at: string;
    capability_report?: HostCapabilityReport;
  }
```

In `applyStartStage`, include:

```ts
if (event.capability_report) {
  childRun.capability_report = event.capability_report;
}
```

- [ ] **Step 5: Pass capability report from runtime engine**

Modify `src/runtime/engine.ts` start stage command:

```ts
const started = applyRuntimeEvents(claimed.snapshot, options.workflow, [{
  type: "start_stage",
  child_run_id: child.child_run_id,
  session_id: child.session_id,
  capability_report: child.capability_report,
  at: options.now,
}]);
```

- [ ] **Step 6: Extend software worker inputs and bridge queue**

Modify `src/orchestrator/software-dev-driver.ts` imports:

```ts
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
import type { RoleDefinition } from "../types/workflow.ts";
```

Extend worker inputs:

```ts
export interface SoftwareDevWorkerRoleContext {
  role_name?: string;
  role?: RoleDefinition;
  timeout_ms?: number;
}

export interface SoftwareDevWorkerInput extends SoftwareDevWorkerRoleContext {
  issue_number: number;
  issue_url: string;
  repo: string;
  branch: string;
  worktree_path?: string;
  fixture_path: string;
  fixture_content: string;
  prompt: string;
}

export interface SoftwareDevVerificationInput extends SoftwareDevWorkerRoleContext {
  pr_number: number;
  pr_url: string;
  expected_fixture_path: string;
  prompt: string;
}

export interface SoftwareDevWorkerResult {
  root_session_id: string;
  child_run_id: string;
  session_id?: string;
  final_response: string;
  shell_fallbacks: 0;
  capability_report?: HostCapabilityReport;
}
```

Extend `QueuedHostSessionBridge` queue:

```ts
private readonly queue: Array<{
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  capabilityReport?: HostCapabilityReport;
}> = [];
```

Change `enqueue` to accept the same shape.

In `startBackgroundChild`, return:

```ts
return {
  child_run_id: run.childRunId,
  root_session_id: request.root_session_id,
  session_id: run.sessionId,
  status: "running",
  agent: request.role.agent,
  load_skills: request.role.load_skills,
  capability_report: run.capabilityReport,
};
```

- [ ] **Step 7: Propagate role context in domain driver**

In every call to `this.worker.runImplementation`, add:

```ts
role_name: input.role.name,
role: input.role.definition,
timeout_ms: input.role.definition.timeout_seconds * 1000,
```

In every call to `this.worker.runVerification`, add:

```ts
role_name: input.role.name,
role: input.role.definition,
timeout_ms: input.role.definition.timeout_seconds * 1000,
```

When enqueuing implementation and verification results, include:

```ts
capabilityReport: implementation.capability_report,
```

and:

```ts
capabilityReport: verification.capability_report,
```

- [ ] **Step 8: Preserve report in host dispatch result**

No large rewrite is needed in `src/orchestrator/host-dispatch.ts`; `StageRootChildRun` extends `HostChildRunResult`, so the optional report flows through after `HostChildRunResult` changes. Add an assertion in `tests/orchestrator/host-dispatch.test.ts` if the existing deterministic host can return a report.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/state-machine.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/host-dispatch.test.ts
```

Expected: all commands pass.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/types/host.ts src/types/control-plane.ts src/runtime/state-machine.ts src/runtime/engine.ts src/orchestrator/host-dispatch.ts src/orchestrator/software-dev-driver.ts tests/orchestrator/software-dev-driver.test.ts tests/runtime/state-machine.test.ts tests/orchestrator/host-dispatch.test.ts
git commit -m "feat: propagate host role capability context"
```

---

### Task 4: Codex And OpenCode Worker Capability Reports

**Files:**
- Modify: `src/adapters/host/codex-worker.ts`
- Modify: `src/adapters/host/opencode-worker.ts`
- Modify: `tests/adapters/sdk-workers.test.ts`

- [ ] **Step 1: Write failing Codex and OpenCode worker tests**

Append to `tests/adapters/sdk-workers.test.ts`:

```ts
test("codex sdk worker reports unsupported optional role capabilities and uses role timeout", async () => {
  let timeoutStarted = false;
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    implementationTimeoutMs: 1,
    loader: async () => ({
      Codex: class {
        startThread() {
          return {
            id: "codex-root",
            async run() {
              timeoutStarted = true;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { finalResponse: "late" };
            },
          };
        }
      },
    }),
  });

  await assert.rejects(() => worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 1,
    },
    timeout_ms: 1,
  }), /CODEX_CREDENTIAL_MISSING/);
  assert.equal(timeoutStarted, true);
});

test("codex sdk worker reports capability status for role metadata", async () => {
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread() {
          return {
            id: "codex-root",
            async run() {
              return { finalResponse: "done" };
            },
          };
        }
      },
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.deepEqual(result.capability_report, {
    host: "codex",
    applied: [],
    defaulted: [],
    unsupported: ["agent", "model", "load_skills"],
  });
});

test("opencode sdk worker passes role agent and reports unsupported skills", async () => {
  let createBody: Record<string, unknown> = {};
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      createOpencode: async () => ({
        client: {
          session: {
            create: async (options: { body?: Record<string, unknown> }) => {
              createBody = options.body ?? {};
              return { data: { id: "opencode-root" } };
            },
            prompt: async () => ({
              data: {
                info: { id: "opencode-message" },
                parts: [{ text: "done" }],
              },
            }),
          },
        },
      }),
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "openai/gpt-5",
      load_skills: ["browser-qa"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.equal(createBody.agent, "review");
  assert.deepEqual(result.capability_report, {
    host: "opencode",
    applied: ["agent"],
    defaulted: [],
    unsupported: ["model", "load_skills"],
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
```

Expected: tests fail because workers ignore `timeout_ms`, do not report capabilities, and OpenCode hard-codes agent `build`.

- [ ] **Step 3: Update Codex worker**

Modify `src/adapters/host/codex-worker.ts`.

Import:

```ts
import { buildCapabilityReport } from "./capabilities.ts";
```

Use per-input timeout:

```ts
async runImplementation(input: SoftwareDevWorkerInput): Promise<SoftwareDevWorkerResult> {
  return await this.run("implement", input, this.implementationTimeoutMs, input.worktree_path);
}

async runVerification(input: SoftwareDevVerificationInput): Promise<SoftwareDevWorkerResult> {
  return await this.run("verify", input, this.verificationTimeoutMs);
}
```

Change the private method signature:

```ts
private async run(
  role: "implement" | "verify",
  input: SoftwareDevWorkerInput | SoftwareDevVerificationInput,
  fallbackTimeoutMs: number,
  workingDirectory = this.workingDirectory,
): Promise<SoftwareDevWorkerResult> {
  const timeoutMs = input.timeout_ms ?? fallbackTimeoutMs;
```

Run the prompt with `input.prompt`.

Return:

```ts
return {
  root_session_id: root.id,
  child_run_id: `${root.id}:${role}`,
  session_id: root.id,
  final_response: turn.finalResponse ?? "",
  shell_fallbacks: 0,
  capability_report: buildCapabilityReport({
    host: "codex",
    unsupported: [
      ...(input.role?.agent ? ["agent" as const] : []),
      ...(input.role?.model ? ["model" as const] : []),
      ...((input.role?.load_skills.length ?? 0) > 0 ? ["load_skills" as const] : []),
    ],
  }),
};
```

- [ ] **Step 4: Update OpenCode worker**

Modify `src/adapters/host/opencode-worker.ts`.

Import:

```ts
import { buildCapabilityReport } from "./capabilities.ts";
```

Use per-input timeout with the same public/private method pattern as Codex.

Change `OpenCodeClientAdapter`:

```ts
interface OpenCodeClientAdapter {
  startRoot(prompt: string, workingDirectory: string, agent: string): Promise<{ id: string }>;
  startChild(rootSessionId: string, prompt: string, workingDirectory: string): Promise<{ id: string; sessionId: string; finalResponse: string }>;
}
```

In current SDK adapter, use the role agent:

```ts
body: { title: prompt.slice(0, 80), agent },
```

Return:

```ts
capability_report: buildCapabilityReport({
  host: "opencode",
  applied: input.role?.agent ? ["agent"] : [],
  unsupported: [
    ...(input.role?.model ? ["model" as const] : []),
    ...((input.role?.load_skills.length ?? 0) > 0 ? ["load_skills" as const] : []),
  ],
}),
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
```

Expected: command passes.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/adapters/host/codex-worker.ts src/adapters/host/opencode-worker.ts tests/adapters/sdk-workers.test.ts
git commit -m "feat: report codex opencode host capabilities"
```

---

### Task 5: Pi SDK Production Worker

**Files:**
- Create: `src/adapters/host/pi-worker.ts`
- Modify: `tests/adapters/sdk-workers.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing Pi worker tests**

Append to `tests/adapters/sdk-workers.test.ts`:

```ts
import { PiSdkSoftwareDevWorker } from "../../src/adapters/host/pi-worker.ts";

test("pi sdk worker starts session, prompts, extracts final assistant text, and reports capabilities", async () => {
  const sessionManagers: Array<{ cwd: string }> = [];
  const createOptions: Record<string, unknown>[] = [];
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers,
      createOptions,
      finalText: "pi completed",
      model: { id: "gpt-5", provider: "openai" },
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    worktree_path: "/repo/.northstar/runtime/worktrees/issue-1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.deepEqual(sessionManagers, [{ cwd: "/repo/.northstar/runtime/worktrees/issue-1" }]);
  assert.equal(createOptions[0].cwd, "/repo/.northstar/runtime/worktrees/issue-1");
  assert.equal((createOptions[0].model as { id: string }).id, "gpt-5");
  assert.equal(result.root_session_id, "pi-session-1");
  assert.equal(result.child_run_id, "pi-session-1:implement");
  assert.equal(result.session_id, "pi-session-1");
  assert.equal(result.final_response, "pi completed");
  assert.deepEqual(result.capability_report, {
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills"],
  });
});

test("pi sdk worker defaults unqualified model and rejects missing final text", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers: [],
      createOptions: [],
      finalText: "",
    }),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  }), /PI_EMPTY_FINAL_RESPONSE/);
});

test("pi sdk worker rejects invalid sdk shape", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({}),
  });

  await assert.rejects(() => worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  }), /HOST_SDK_CONFIG_INVALID/);
});
```

Add this helper at the bottom of `tests/adapters/sdk-workers.test.ts`:

```ts
function fakePiSdk(input: {
  sessionManagers: Array<{ cwd: string }>;
  createOptions: Record<string, unknown>[];
  finalText: string;
  model?: { id: string; provider: string };
}) {
  return {
    SessionManager: {
      create(cwd: string) {
        input.sessionManagers.push({ cwd });
        return { cwd };
      },
    },
    ModelRegistry: {
      create() {
        return {
          find(provider: string, modelId: string) {
            if (!input.model) return undefined;
            return input.model.provider === provider && input.model.id === modelId ? input.model : undefined;
          },
        };
      },
    },
    getAgentDir() {
      return "/home/test/.pi/agent";
    },
    async createAgentSession(options: Record<string, unknown>) {
      input.createOptions.push(options);
      let listener: ((event: unknown) => void) | undefined;
      return {
        session: {
          sessionId: "pi-session-1",
          sessionFile: "/home/test/.pi/agent/sessions/repo/session.jsonl",
          subscribe(next: (event: unknown) => void) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({
              type: "agent_end",
              willRetry: false,
              messages: [{
                role: "assistant",
                content: input.finalText
                  ? [{ type: "text", text: input.finalText }]
                  : [],
              }],
            });
          },
          dispose() {},
        },
      };
    },
  };
}
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
```

Expected: command fails because `PiSdkSoftwareDevWorker` does not exist.

- [ ] **Step 3: Add Pi worker**

Create `src/adapters/host/pi-worker.ts`:

```ts
import type {
  SoftwareDevVerificationInput,
  SoftwareDevWorker,
  SoftwareDevWorkerInput,
  SoftwareDevWorkerResult,
} from "../../orchestrator/software-dev-driver.ts";
import { buildCapabilityReport, parseHostModelReference, type HostCapabilityReport } from "./capabilities.ts";
import { piLoader } from "./sdk-loaders.ts";

type PiEventListener = (event: unknown) => void;

interface PiSessionLike {
  sessionId: string;
  sessionFile?: string;
  subscribe(listener: PiEventListener): () => void;
  prompt(text: string): Promise<void>;
  dispose?: () => void;
}

interface PiSdkLike {
  SessionManager?: {
    create(cwd: string, sessionDir?: string): unknown;
  };
  ModelRegistry?: {
    create(...args: unknown[]): { find(provider: string, modelId: string): unknown };
  };
  getAgentDir?: () => string;
  createAgentSession?: (options: Record<string, unknown>) => Promise<{ session: PiSessionLike }>;
}

export class PiSdkSoftwareDevWorker implements SoftwareDevWorker {
  private readonly loader: () => Promise<unknown>;
  private readonly workingDirectory: string;
  private readonly implementationTimeoutMs: number;
  private readonly verificationTimeoutMs: number;

  constructor(options: {
    loader?: () => Promise<unknown>;
    workingDirectory: string;
    implementationTimeoutMs?: number;
    verificationTimeoutMs?: number;
  }) {
    this.loader = options.loader ?? piLoader;
    this.workingDirectory = options.workingDirectory;
    this.implementationTimeoutMs = options.implementationTimeoutMs ?? 300_000;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 180_000;
  }

  async runImplementation(input: SoftwareDevWorkerInput): Promise<SoftwareDevWorkerResult> {
    return await this.run("implement", input, this.implementationTimeoutMs, input.worktree_path);
  }

  async runVerification(input: SoftwareDevVerificationInput): Promise<SoftwareDevWorkerResult> {
    return await this.run("verify", input, this.verificationTimeoutMs);
  }

  private async run(
    kind: "implement" | "verify",
    input: SoftwareDevWorkerInput | SoftwareDevVerificationInput,
    fallbackTimeoutMs: number,
    workingDirectory = this.workingDirectory,
  ): Promise<SoftwareDevWorkerResult> {
    const timeoutMs = input.timeout_ms ?? fallbackTimeoutMs;
    const sdk = await this.loadSdk();
    const modelResult = resolvePiModel(sdk, input.role?.model);
    const sessionManager = sdk.SessionManager!.create(workingDirectory);
    const { session } = await sdk.createAgentSession!({
      cwd: workingDirectory,
      agentDir: sdk.getAgentDir?.(),
      sessionManager,
      ...(modelResult.model ? { model: modelResult.model } : {}),
    });
    const capabilityReport = buildPiCapabilityReport(input, modelResult.report);

    try {
      const finalResponse = await withTimeout(
        promptAndWaitForFinalResponse(session, input.prompt),
        timeoutMs,
        `PI_CREDENTIAL_MISSING: Pi ${kind} worker timed out or could not authenticate`,
      );
      return {
        root_session_id: session.sessionId,
        child_run_id: `${session.sessionId}:${kind}`,
        session_id: session.sessionId,
        final_response: finalResponse,
        shell_fallbacks: 0,
        capability_report: capabilityReport,
      };
    } finally {
      session.dispose?.();
    }
  }

  private async loadSdk(): Promise<PiSdkLike> {
    const sdk = await this.loader() as PiSdkLike;
    if (!sdk.SessionManager?.create) {
      throw new Error("HOST_SDK_CONFIG_INVALID: Pi SDK missing SessionManager");
    }
    if (!sdk.createAgentSession) {
      throw new Error("HOST_SDK_CONFIG_INVALID: Pi SDK missing createAgentSession");
    }
    return sdk;
  }
}

function resolvePiModel(
  sdk: PiSdkLike,
  rawModel: string | undefined,
): { model?: unknown; report: Pick<HostCapabilityReport, "applied" | "defaulted" | "unsupported"> } {
  const parsed = parseHostModelReference(rawModel);
  if (!parsed) {
    return { report: { applied: [], defaulted: ["model"], unsupported: [] } };
  }
  if (!parsed.provider) {
    return { report: { applied: [], defaulted: ["model"], unsupported: [] } };
  }
  const registry = sdk.ModelRegistry?.create?.();
  const model = registry?.find(parsed.provider, parsed.modelId);
  if (!model) {
    throw new Error(`HOST_SDK_CONFIG_INVALID: Pi model not found: ${parsed.provider}/${parsed.modelId}`);
  }
  return { model, report: { applied: ["model"], defaulted: [], unsupported: [] } };
}

function buildPiCapabilityReport(
  input: SoftwareDevWorkerInput | SoftwareDevVerificationInput,
  modelReport: Pick<HostCapabilityReport, "applied" | "defaulted" | "unsupported">,
): HostCapabilityReport {
  return buildCapabilityReport({
    host: "pi",
    applied: modelReport.applied,
    defaulted: [
      ...modelReport.defaulted,
      ...(input.role?.agent ? ["agent" as const] : []),
    ],
    unsupported: [
      ...modelReport.unsupported,
      ...((input.role?.load_skills.length ?? 0) > 0 ? ["load_skills" as const] : []),
    ],
  });
}

async function promptAndWaitForFinalResponse(session: PiSessionLike, prompt: string): Promise<string> {
  let unsubscribe: (() => void) | undefined;
  try {
    const finalResponse = new Promise<string>((resolve, reject) => {
      unsubscribe = session.subscribe((event) => {
        if (isRecord(event) && event.type === "agent_end") {
          try {
            resolve(extractFinalAssistantText(event.messages));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    await session.prompt(prompt);
    return await finalResponse;
  } finally {
    unsubscribe?.();
  }
}

function extractFinalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    throw new Error("PI_EMPTY_FINAL_RESPONSE: Pi agent_end event did not include messages");
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = extractTextContent(message.content).trim();
    if (text.length > 0) return text;
  }
  throw new Error("PI_EMPTY_FINAL_RESPONSE: Pi worker did not emit assistant text");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Ensure test index already imports SDK worker tests**

`tests/index.test.ts` already imports `./adapters/sdk-workers.test.ts`. Do not add a duplicate import.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
```

Expected: command passes.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/adapters/host/pi-worker.ts tests/adapters/sdk-workers.test.ts tests/index.test.ts
git commit -m "feat: add pi sdk software worker"
```

---

### Task 6: Production Dependency Wiring And Symmetry Tests

**Files:**
- Modify: `src/orchestrator/production-dependencies.ts`
- Modify: `tests/orchestrator/production-dependencies.test.ts`

- [ ] **Step 1: Write failing production dependency tests**

Modify `tests/orchestrator/production-dependencies.test.ts`.

Change fixture input type:

```ts
hostAdapter: "codex" | "opencode" | "pi";
```

Change `fakeWorker`:

```ts
function fakeWorker(kind: "codex" | "opencode" | "pi"): SoftwareDevWorker & { kind: "codex" | "opencode" | "pi" } {
```

In `default production factory creates real dependency composition`, pass a Pi worker injection:

```ts
sdkWorkers: {
  codex: () => fakeWorker("codex"),
  opencode: () => fakeWorker("opencode"),
  pi: () => fakeWorker("pi"),
},
```

Add this test:

```ts
test("production factory wires pi worker symmetrically with codex and opencode", async () => {
  const config = fixtureConfig({
    projectRoot: "/repo",
    repo: "owner/repo",
    hostAdapter: "pi",
  });
  const created = await createProductionDependencies({
    config,
    usage: "watch",
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async () => jsonResponse([]),
    sdkWorkers: {
      codex: () => fakeWorker("codex"),
      opencode: () => fakeWorker("opencode"),
      pi: () => fakeWorker("pi"),
    },
  });

  const driver = created.registry.resolve({
    workflow: loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml"),
    config,
    dependencies: {},
  }) as unknown as {
    worker: { factory: { resolveHostForRole(roleName: string): string; workerForRole(roleName: string): { kind: string } } };
  };

  assert.equal(driver.worker.factory.resolveHostForRole("issue_worker"), "pi");
  assert.equal(driver.worker.factory.workerForRole("issue_worker").kind, "pi");
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/production-dependencies.test.ts
```

Expected: command fails because `sdkWorkers.pi` and production Pi construction do not exist.

- [ ] **Step 3: Wire Pi dependencies**

Modify `src/orchestrator/production-dependencies.ts`.

Import Pi worker:

```ts
import { PiSdkSoftwareDevWorker } from "../adapters/host/pi-worker.ts";
```

Extend `sdkWorkers` input:

```ts
sdkWorkers?: {
  codex?: () => SoftwareDevWorker;
  opencode?: () => SoftwareDevWorker;
  pi?: () => SoftwareDevWorker;
};
```

Extend default credentials:

```ts
hostSdk: {
  codex: { mode: "sdk_default" as const },
  opencode: { mode: "sdk_default" as const },
  pi: { mode: "sdk_default" as const },
},
```

Add `piWorker` to `HostWorkerFactory`:

```ts
piWorker: input.sdkWorkers?.pi ?? (() => new PiSdkSoftwareDevWorker({
  workingDirectory: input.config.project.root,
  implementationTimeoutMs: sdkWorkerTimeoutMs,
  verificationTimeoutMs: sdkWorkerTimeoutMs,
})),
```

- [ ] **Step 4: Run focused test and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/production-dependencies.test.ts
```

Expected: command passes.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/orchestrator/production-dependencies.ts tests/orchestrator/production-dependencies.test.ts
git commit -m "feat: wire pi production dependencies"
```

---

### Task 7: Full Regression And Documentation Coverage

**Files:**
- Modify: `docs/superpowers/cli-adapters-coverage.md`
- Modify: `docs/superpowers/production-orchestrator-coverage.md`
- Modify: `docs/superpowers/opencode-full-live-e2e-coverage.md` only if assertions mention only two hosts

- [ ] **Step 1: Update coverage docs**

In `docs/superpowers/cli-adapters-coverage.md`, update the host adapters row to include:

```markdown
`src/adapters/host/pi-worker.ts`, `src/adapters/host/capabilities.ts`
```

In `docs/superpowers/production-orchestrator-coverage.md`, add a row or sentence:

```markdown
| Pi host capability path | `runtime.host_adapter: pi`, role-level host overrides, role metadata propagation, and optional capability reports are covered by unit tests. MCP is represented as capability vocabulary only and has no first-implementation application path. | `tests/config/load-config.test.ts`, `tests/adapters/host-worker-factory.test.ts`, `tests/adapters/sdk-workers.test.ts`, `tests/orchestrator/production-dependencies.test.ts` | `src/adapters/host/capabilities.ts`, `src/adapters/host/pi-worker.ts`, `src/orchestrator/production-dependencies.ts` |
```

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run requirement coverage**

Run:

```bash
npm run test:coverage:requirements
```

Expected: requirement coverage passes with no missing implementation/test mapping for the new plan/spec docs.

- [ ] **Step 4: Search for forbidden implementation paths**

Run:

```bash
rg -n "pi-web|__piSessions|mcp_servers.*create|mcp_servers.*configure|MCP.*server.*start" src tests docs/superpowers/specs/2026-06-01-northstar-pi-host-capability-design.md
```

Expected output may include the design/spec non-goal statements and tests that assert `mcp_servers` is unsupported. It must not show production code importing `pi-web` or configuring MCP servers.

- [ ] **Step 5: Commit docs and final fixes**

Run:

```bash
git add docs/superpowers/cli-adapters-coverage.md docs/superpowers/production-orchestrator-coverage.md docs/superpowers/opencode-full-live-e2e-coverage.md
git commit -m "docs: cover pi host capability path"
```

If `git diff --cached --quiet` reports no staged documentation changes, skip this commit and record in the final implementation notes that coverage docs already satisfied the new paths.

---

## Final Verification

Run after all tasks:

```bash
npm test
npm run test:coverage:requirements
git status --short --branch
```

Expected:

- `npm test` passes.
- `npm run test:coverage:requirements` passes.
- `git status --short --branch` shows no uncommitted implementation changes.

## Acceptance Criteria Mapping

- AC-PI-01: Task 2 config tests.
- AC-PI-02: Task 2 worker factory tests.
- AC-PI-03: Task 2 worker factory role override test and Task 6 production dependency test.
- AC-PI-04: Task 2 unknown host tests.
- AC-PI-05: Task 6 production dependency test.
- AC-PI-06: Task 3 software-dev driver role context test.
- AC-PI-07: Task 3 and Task 4 timeout tests.
- AC-PI-08: Task 1 Pi loader test.
- AC-PI-09: Task 5 Pi fake SDK test and Task 7 forbidden import search.
- AC-PI-10: Task 5 final assistant extraction test.
- AC-PI-11: Task 3 and Task 4 capability report tests.
- AC-PI-12: Task 4 and Task 5 unsupported optional capability tests.
- AC-PI-13: Task 1 vocabulary test and Task 7 forbidden MCP configuration search.
- AC-PI-14: Task 4 existing Codex/OpenCode worker tests and final `npm test`.
- AC-PI-15: Task 4 and Task 5 worker result assertions plus final regression.
