# Northstar Pi Host Capability Design

Date: 2026-06-01

## Goal

Add Pi as a production host choice while making role metadata handling consistent across Codex, OpenCode, and Pi.

The production path must support:

- `runtime.host_adapter: pi`
- role override `host_adapter: pi`
- a shared worker request contract for Codex, OpenCode, and Pi
- optional model, skill, tool, reasoning, and future MCP capability reporting
- Pi SDK integration through `@earendil-works/pi-coding-agent`

The design must not depend on `pi-web`. `pi-web` is only a reference for Pi session management concepts such as `SessionManager`, session files, `createAgentSession`, `subscribe`, and `prompt`.

## Current Context

Northstar already has a host abstraction at two levels.

Runtime host adapters implement `HostAdapter`:

- `src/adapters/host/codex.ts`
- `src/adapters/host/opencode.ts`
- `src/adapters/host/fake.ts`

Production software-development workers implement `SoftwareDevWorker`:

- `src/adapters/host/codex-worker.ts`
- `src/adapters/host/opencode-worker.ts`
- `src/adapters/host/worker-factory.ts`
- `src/orchestrator/production-dependencies.ts`

The workflow schema already includes role metadata:

```ts
interface RoleDefinition {
  run_mode: string;
  agent: string;
  model?: string;
  load_skills: string[];
  prompt_template?: string;
  artifact?: string;
  timeout_seconds: number;
  retry_policy?: RetryPolicy;
}
```

The gap is that production SDK workers do not receive the full role context. They mostly receive prompt and worktree data, so `model`, `load_skills`, and role-level timeout behavior are not applied or reported consistently by Codex and OpenCode. Pi should not be added as a special case; it should use the same role metadata contract as the existing hosts.

## Non-Goals

This change does not implement MCP server wiring.

This change does not use `pi-web` APIs, routes, SSE streams, UI state, or wrappers.

This change does not add host-specific workflow schemas such as `roles.issue_worker.pi.*`, `roles.issue_worker.codex.*`, or `roles.issue_worker.opencode.*` as the primary configuration model.

This change does not use prompt-only claims to pretend that a model, skill, tool, or MCP capability was applied.

## Design Summary

Codex, OpenCode, and Pi become peers behind a shared production host execution request.

```text
workflow role + workflow_overrides
  -> resolveWorkflowRoles()
  -> SoftwareDevDomainDriver stage selection
  -> HostWorkerFactory selects codex, opencode, or pi
  -> RoleDelegatingSoftwareDevWorker builds HostExecutionRequest
  -> selected SDK worker maps role metadata to host SDK options
  -> worker returns SoftwareDevWorkerResult plus HostCapabilityReport
  -> QueuedHostSessionBridge records root, child, and session ids
  -> runtime child run stores host metadata for audit
```

Each worker receives the same canonical request shape:

```ts
interface HostExecutionRequest {
  host: "codex" | "opencode" | "pi";
  role_name: string;
  role: RoleDefinition;
  execution: {
    prompt: string;
    working_directory: string;
    issue_number?: number;
    issue_url?: string;
    repo?: string;
    branch?: string;
    pr_number?: number;
    pr_url?: string;
  };
}
```

The result extends the current software worker result with capability metadata:

```ts
interface HostCapabilityReport {
  host: "codex" | "opencode" | "pi";
  applied: string[];
  defaulted: string[];
  unsupported: string[];
}

interface SoftwareDevWorkerResult {
  root_session_id: string;
  child_run_id: string;
  session_id?: string;
  final_response: string;
  shell_fallbacks: 0;
  capability_report?: HostCapabilityReport;
}
```

The capability report is audit metadata. Optional unsupported capabilities do not block lifecycle progression. Required capability enforcement is a future policy feature and is not part of this implementation.

## Canonical Role Parameters

The first implementation passes these parameters to every production SDK worker:

- `role_name`
- `role.agent`
- `role.model`
- `role.load_skills`
- `role.timeout_seconds`
- `execution.prompt`
- `execution.working_directory`

`role.timeout_seconds` takes precedence over `runtime.child_timeout_seconds` for that worker run. If the role timeout is missing in a future schema version, the runtime child timeout remains the fallback.

`role.model` supports two formats:

```yaml
model: gpt-5
model: openai/gpt-5
model: anthropic/claude-sonnet-4-6
```

A model string without a provider is resolved through the host default model behavior. A `provider/model` string gives hosts that need explicit provider selection, especially Pi, enough information to resolve the requested model through their SDK.

`role.load_skills` is passed as a canonical list. A host mapper may apply the list only if the host SDK has a stable skill or resource-loading API for that behavior. Otherwise the mapper reports `load_skills` as unsupported.

## Optional Capability Vocabulary

The common capability vocabulary is:

- `agent`
- `model`
- `load_skills`
- `tools`
- `reasoning_effort`
- `mcp_servers`

`mcp_servers` is design-only in this version. It is included so future workflow and host configuration can describe MCP needs consistently across Codex, OpenCode, and Pi. No worker attempts to configure MCP servers in the first implementation.

Capability statuses are:

- `applied`: the host SDK accepted and used the value through a stable API.
- `defaulted`: no explicit value was applied and the host default was used.
- `unsupported`: the request included a value, but the host mapper could not apply it through a stable SDK API.

Workers must not silently drop requested optional capabilities. They either apply, default, or report unsupported.

## Host Mapping

### Codex

Codex continues to use the Codex SDK through a dynamic import boundary.

The worker maps:

- `execution.working_directory` to Codex thread `workingDirectory`
- role timeout to the worker timeout
- `role.model` to Codex model selection only if the installed SDK exposes a stable option
- `reasoning_effort` to Codex `modelReasoningEffort` when added later

If Codex SDK support for model or skills is unavailable or unverified, the worker reports those capabilities as unsupported or defaulted instead of adding prompt text that claims the skills were loaded.

### OpenCode

OpenCode continues to use `@opencode-ai/sdk`.

The worker maps:

- `execution.working_directory` to the SDK directory query
- `role.agent` to the session create body when supported
- role timeout to the worker timeout
- `role.model` to OpenCode model selection only if the installed SDK exposes a stable option

If OpenCode SDK support for skills, model, or MCP is unavailable or unverified, the worker reports unsupported/defaulted capability status.

### Pi

Pi is added as a first-class production host through `@earendil-works/pi-coding-agent`.

Northstar adds the package as an optional dependency and loads it dynamically.

The Pi worker uses Pi SDK primitives directly:

- `SessionManager.create()` or the nearest stable SDK equivalent for a new session in the execution working directory
- `createAgentSession({ cwd, agentDir, sessionManager, model? })`
- `ModelRegistry` or the nearest stable SDK model registry API for `provider/model` resolution
- `session.subscribe()` to capture events
- `session.prompt(execution.prompt)` to run the prompt
- terminal agent events or timeout to finish the worker call
- `session.dispose()` or the nearest stable cleanup API after completion

The Pi worker does not call `pi-web` routes, import `pi-web` code, open web SSE streams, or depend on `globalThis.__piSessions`.

The Pi worker returns:

- `root_session_id`: Pi session id
- `child_run_id`: deterministic role-specific child id derived from the Pi session id and run kind
- `session_id`: Pi session id
- `final_response`: final assistant text extracted from Pi events
- `shell_fallbacks`: `0`
- `capability_report`: applied/defaulted/unsupported capabilities

If Pi does not emit a final assistant text in a stable event shape, the worker returns an actionable SDK boundary error instead of inventing a successful response.

## Configuration

`HostAdapterName` expands from:

```ts
type HostAdapterName = "codex" | "opencode";
```

to:

```ts
type HostAdapterName = "codex" | "opencode" | "pi";
```

`runtime.host_adapter` accepts `pi`.

Role override `host_adapter` accepts `pi`.

Credentials config expands to include Pi:

```yaml
credentials:
  host_sdk:
    codex:
      mode: sdk_default
    opencode:
      mode: sdk_default
    pi:
      mode: sdk_default
```

The first implementation does not require raw Pi credentials in `.northstar.yaml`. Pi credentials are resolved by the Pi SDK default configuration and auth storage.

## Error Handling

Errors are categorized as:

### Missing SDK or Invalid SDK Shape

If `@earendil-works/pi-coding-agent`, `@openai/codex-sdk`, or `@opencode-ai/sdk` is missing when selected, the worker fails with an actionable host SDK configuration error.

Examples:

- `HOST_SDK_CONFIG_INVALID: Pi SDK missing createAgentSession`
- `HOST_SDK_CONFIG_INVALID: Pi SDK missing SessionManager`
- `HOST_SDK_CONFIG_INVALID: OpenCode SDK missing session APIs`

### Missing Credentials or Timeout

If the selected host cannot authenticate or does not finish before the role timeout, the worker returns a host-specific actionable error. The error must not include tokens, API keys, authorization headers, or full process environments.

### Optional Capability Unsupported

If `model`, `load_skills`, `tools`, `reasoning_effort`, or `mcp_servers` cannot be applied and is not required by policy, the worker records the unsupported capability and continues.

### Empty or Unsafe Worker Output

Existing worker output validation remains in force:

- final response must not be empty
- final response must not contain secret-shaped values
- shell fallback count remains `0`

## Testing Strategy

Unit tests cover:

- config validation accepts `runtime.host_adapter: pi`
- config validation rejects unknown hosts
- `HostWorkerFactory` resolves `pi` as a global default
- `HostWorkerFactory` resolves role override `host_adapter: pi`
- `HostWorkerFactory` rejects unknown role host values
- production dependency factory wires Codex, OpenCode, and Pi worker factories symmetrically
- worker requests include `role_name`, `role.agent`, `role.model`, `role.load_skills`, and role timeout
- Codex and OpenCode existing worker behavior remains compatible
- Pi loader dynamically imports `@earendil-works/pi-coding-agent`
- Pi worker uses fake SDK `SessionManager`, `createAgentSession`, `subscribe`, and `prompt`
- Pi worker resolves `provider/model` through a fake model registry when supported
- capability report records applied/defaulted/unsupported capabilities
- MCP appears in the capability vocabulary but no worker attempts to apply it

Focused integration tests cover:

- a production factory run with `runtime.host_adapter: pi`
- a role override that routes implementation to Pi and verification to Codex or OpenCode
- timeout behavior uses `role.timeout_seconds`
- unsupported optional capabilities are observable but do not fail lifecycle

No live Pi E2E is required for the first implementation unless a later plan explicitly adds a live gate.

## Acceptance Criteria

- AC-PI-01: `RuntimeConfig` accepts `runtime.host_adapter: pi`.
- AC-PI-02: `HostWorkerFactory` supports `codex`, `opencode`, and `pi` as default hosts.
- AC-PI-03: role override `host_adapter: pi` selects the Pi worker.
- AC-PI-04: unknown host names still fail with `HOST_ADAPTER_UNKNOWN`.
- AC-PI-05: production dependency construction exposes Codex, OpenCode, and Pi worker factories through one symmetric path.
- AC-PI-06: production worker input includes role name, agent, model, load skills, timeout, prompt, and working directory.
- AC-PI-07: role timeout takes precedence over runtime child timeout for Codex, OpenCode, and Pi workers.
- AC-PI-08: Pi SDK loading is behind a dynamic import boundary.
- AC-PI-09: Pi worker starts a Pi SDK session without importing `pi-web`.
- AC-PI-10: Pi worker captures final response from fake SDK events and returns a `SoftwareDevWorkerResult`.
- AC-PI-11: worker results can include a `HostCapabilityReport`.
- AC-PI-12: unsupported optional capabilities are reported and not silently dropped.
- AC-PI-13: MCP is represented in the capability vocabulary but has no first-implementation application path.
- AC-PI-14: tests prove Codex and OpenCode behavior remains compatible after the shared request contract change.
- AC-PI-15: no worker uses shell fallback for host execution.

## Implementation Boundaries

The implementation plan should be split into:

1. Shared host capability/request types.
2. Config and worker factory support for `pi`.
3. Production worker request propagation from domain driver to worker.
4. Pi SDK loader and Pi worker with fake SDK tests.
5. Capability report propagation and audit tests.
6. Documentation and optional dependency updates.

The MCP capability must remain documentation and type vocabulary only in this first implementation.
