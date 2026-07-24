# Southstar Playwright CLI Browser Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require runtime-observed Playwright CLI execution before a blocking `browser_interaction` Criterion can pass.

**Architecture:** Reuse the approved `tool.test-runner` → Pi `bash` path and the existing requirement evaluator/completion gate. The Pi harness records actual bash executions, while a small evaluator helper validates the browser command sequence and contributes fail-closed findings.

**Tech Stack:** Node.js 24, TypeScript, Pi SDK harness events, official `@playwright/cli`, Node test runner.

## Global Constraints

- Use active `src/v2/` runtime and the existing evaluator lifecycle.
- Use approved Library grants; do not hardcode a parallel tool-selection path.
- Do not trust evaluator-authored command claims for browser acceptance.
- Do not modify unrelated dirty-worktree changes.
- Do not commit, merge, push, or run live E2E without explicit user authorization.

---

### Task 1: Capture runtime-observed commands

**Files:**
- Modify: `src/v2/harness/types.ts`
- Modify: `src/v2/harness/pi-sdk-harness.ts`
- Test: `tests/v2/pi-sdk-harness.test.ts`

**Interfaces:**
- Produces: `HarnessCommandExecution` and optional `HarnessRunResult.commandExecutions`.
- Produces: browser evaluator artifacts whose `runtimeCommandExecutions`, `commandsRun`, and `testResults` are harness-authored.

- [ ] **Step 1: Write the failing harness test**

Emit `tool_execution_start`, `tool_execution_end`, and `agent_end` from the fake Pi session, then assert that the returned browser evaluator artifact contains:

```ts
{
  runtimeCommandExecutions: [{
    ref: "playwright-cli open http://127.0.0.1:30141",
    command: "playwright-cli open http://127.0.0.1:30141",
    status: "passed",
    ok: true,
  }],
}
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx tests/v2/pi-sdk-harness.test.ts
```

Expected: the new runtime command evidence assertion fails because the harness currently records only assistant text.

- [ ] **Step 3: Implement minimal event capture**

Add the command execution type, pair start/end events by `toolCallId`, and attach redacted bash command records. For browser evaluator pipelines, replace `commandsRun` and `testResults` with the observed records so model-authored claims cannot mask missing execution.

- [ ] **Step 4: Verify GREEN**

Run the same focused test and expect zero failures.

### Task 2: Fail closed on insufficient browser CLI evidence

**Files:**
- Create: `src/v2/evaluators/browser-cli-evidence.ts`
- Modify: `src/v2/evaluators/requirement-evaluator-results.ts`
- Create: `tests/v2/browser-cli-evidence.test.ts`
- Modify: `tests/v2/index.test.ts`

**Interfaces:**
- Produces: `browserCliEvidenceFindings(artifact, expectedKinds): string[]`.
- Consumes: harness-authored `artifact.runtimeCommandExecutions`.

- [ ] **Step 1: Write failing evidence tests**

Cover:

```ts
assert.deepEqual(browserCliEvidenceFindings({}, ["command-output"]), [
  "browser criterion has no runtime-observed playwright-cli execution",
]);
```

Also cover a valid `open` + `find` sequence, a failed command, and screenshot evidence without a successful `screenshot` command.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx tests/v2/browser-cli-evidence.test.ts
```

Expected: module/function not found.

- [ ] **Step 3: Implement the smallest parser and validator**

Accept only a direct `playwright-cli` invocation without shell chaining. Extract its subcommand, require navigation plus observation, require all observed CLI commands to succeed, and require `screenshot` when frozen evidence demands it.

- [ ] **Step 4: Apply findings to only browser Criterion results**

In `evaluateCriterionResult`, append the helper findings only when `binding.verificationMode === "browser_interaction"`.

- [ ] **Step 5: Verify GREEN**

Run the focused evidence and harness tests and expect zero failures.

### Task 3: Expose the official CLI and evaluator instruction

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docker/pi-agent/Dockerfile`
- Modify: `library/evaluators/software-engineering-general.evaluator.yaml`
- Modify: `src/v2/agent-runner/task-envelope.ts`
- Test: `tests/v2/task-envelope-v2.test.ts`

**Interfaces:**
- Produces: pinned `/usr/local/bin/playwright-cli` in `southstar/pi-agent:local`.
- Produces: evaluator prompt containing the frozen procedure instruction and runtime-evidence warning.

- [ ] **Step 1: Write the failing prompt test**

Create a browser evaluator pipeline step and assert the rendered prompt includes the procedure instruction and says browser command claims require runtime-observed `playwright-cli` execution.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx tests/v2/task-envelope-v2.test.ts
```

Expected: prompt assertion fails because the formatter currently omits procedure instructions.

- [ ] **Step 3: Add the pinned dependency and image wiring**

Install the exact approved CLI version:

```bash
npm install --save-dev --save-exact @playwright/cli@0.1.17
```

After `npm ci`, make the local binary available and install the CLI package's matching Chromium:

```dockerfile
RUN ln -s /app/node_modules/.bin/playwright-cli /usr/local/bin/playwright-cli \
  && playwright-cli install-browser chromium
```

- [ ] **Step 4: Render the procedure instruction**

Include each Criterion step's `instruction` in the evaluator pipeline prompt. Update the approved browser procedure to require direct `playwright-cli` commands, bounded named sessions, screenshots/traces when requested, and cleanup.

- [ ] **Step 5: Verify focused tests and CLI availability**

Run:

```bash
npx --no-install playwright-cli --version
node --test --import tsx tests/v2/task-envelope-v2.test.ts tests/v2/pi-sdk-harness.test.ts tests/v2/browser-cli-evidence.test.ts
```

Expected: pinned CLI version prints and all focused tests pass.

### Task 4: Image and regression verification

**Files:**
- Verify only.

- [ ] **Step 1: Run static and focused gates**

```bash
npx tsc --noEmit
npm run test:v2
git diff --check
```

- [ ] **Step 2: Rebuild the Pi image**

Use the repository's existing Pi image build script or equivalent Docker build command for `southstar/pi-agent:local`.

- [ ] **Step 3: Smoke-test the image**

Verify inside the image:

```bash
playwright-cli --version
playwright-cli install-browser --help
```

Run a bounded headless local-page interaction that performs navigation, snapshot/find, screenshot, and clean session close.

- [ ] **Step 4: Review scoped diff**

Inspect only the files listed in this plan, confirm no unrelated dirty changes were altered, and report any verification limit without claiming real Goal → Tork → Pi browser E2E.
