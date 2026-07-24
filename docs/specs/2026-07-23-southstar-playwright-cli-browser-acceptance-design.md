# Southstar Playwright CLI Browser Acceptance Design

## Goal

Make a `browser_interaction` Criterion pass only when its independent evaluator actually operates a browser through the official Playwright CLI and Southstar observes that execution.

## Decision

Use the official pinned `@playwright/cli` package inside `southstar/pi-agent:local`. Do not build a Playwright MCP server or an MCP bridge.

The existing `tool.test-runner` Library primitive already materializes Pi's `bash` tool. Evaluators use that approved runtime grant to invoke `playwright-cli`. The Pi harness records `tool_execution_start` and `tool_execution_end` events and replaces browser-evaluator command claims with the commands it actually observed.

## Acceptance boundary

For each frozen Criterion whose `verificationMode` is `browser_interaction`:

- At least one successful runtime-observed `playwright-cli open` or `playwright-cli goto` command is required.
- At least one successful runtime-observed observation command is required: `snapshot`, `find`, `eval`, `run-code`, `screenshot`, or `console`.
- Any failed runtime-observed Playwright CLI command blocks the Criterion.
- Any runtime-observed Playwright CLI invocation hidden inside a shell chain or wrapper blocks the Criterion; accepted evidence must come from direct `playwright-cli` commands.
- If screenshot evidence is frozen into the Criterion, a successful runtime-observed `playwright-cli screenshot` command is also required.
- Evaluator-authored `commandsRun` or `testResults` values do not satisfy these checks unless the Pi harness observed the matching bash execution.

Existing screenshot byte/provenance validation, URL validation, frozen evaluator/version lineage, producer-artifact lineage, and completion-gate checks remain authoritative.

## Runtime flow

```text
approved tool.test-runner grant
  -> Pi bash tool
  -> pinned playwright-cli command
  -> Pi tool execution events
  -> harness-authored runtime command records
  -> requirement evaluator browser-trace validation
  -> existing evidence packet and completion gate
```

## Image

The Pi image installs a pinned `@playwright/cli` version during `npm ci`, installs its matching Chromium through `playwright-cli install-browser chromium`, and exposes the local executable at `/usr/local/bin/playwright-cli`.

The image must be rebuilt after these changes because dependencies and `src/v2/harness/` are copied into the image.

## Non-goals

- No custom browser automation implementation.
- No Playwright MCP server.
- No second QA workflow or evaluator lifecycle.
- No semantic claim that a screenshot alone proves the Criterion.
- No commit, merge, push, or live full E2E unless explicitly requested.
