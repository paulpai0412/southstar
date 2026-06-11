# Northstar Skill Phase Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the phase-based Northstar skill UX so consumer repositories can use `/northstar-plan`, `/northstar-setup`, `/northstar-execute`, `/northstar-observe`, `/northstar-recover`, and `/northstar-report` with stable aliases, offline verification, and global sync.

**Architecture:** Add a first-class `skills/northstar` skill package with a short `SKILL.md` entrypoint and command-specific reference files. Keep executable skill support in small ESM helper modules under `skills/northstar/scripts/lib`, with unit tests proving command mapping, guided execution previews, Project viewer diffs, recovery classification, report shaping, and local consumer repo simulation.

**Tech Stack:** Node.js ESM, `node:test`, repository-local skill files, existing `node --run northstar` CLI entrypoint.

---

## Implementation Notes

- Work from `main`.
- Do not pop or modify unrelated stashes.
- Keep all tests offline. No GitHub token, network, Codex/OpenCode credentials, host CLIs, or browser session should be required.
- Do not implement live Project API mutation in this plan. Only implement command planning, reference docs, and local simulation helpers.
- Use explicit argv arrays. Do not construct shell-chain strings.
- Use `apply_patch` for manual file edits.

## File Structure

Create:

- `skills/northstar/SKILL.md` — short skill entrypoint and command routing rules.
- `skills/northstar/README.md` — local/global skill usage summary.
- `skills/northstar/references/commands/plan.md` — `/northstar-plan` and planning aliases.
- `skills/northstar/references/commands/setup.md` — `/northstar-setup` and `/northstar-init`.
- `skills/northstar/references/commands/execute.md` — `/northstar-execute` and `/northstar-watch`.
- `skills/northstar/references/commands/observe.md` — `/northstar-observe` and `/northstar-status`.
- `skills/northstar/references/commands/recover.md` — `/northstar-recover` and `/northstar-recovery`.
- `skills/northstar/references/commands/report.md` — `/northstar-report`.
- `skills/northstar/references/issue-table-schema.md` — Northstar issue table schema for plan-to-issues.
- `skills/northstar/references/project-viewer.md` — Project fields/views and repair policy.
- `skills/northstar/references/safety-rules.md` — mutation and secret-safety rules.
- `skills/northstar/references/training-manual.md` — optional training manual report format.
- `skills/northstar/templates/northstar.yaml` — consumer config template.
- `skills/northstar/templates/workflow.issue-to-pr-release.yaml` — minimal workflow template.
- `skills/northstar/scripts/lib/operator-commands.mjs` — phase command and alias to CLI argv mapping.
- `skills/northstar/scripts/lib/execution-guide.mjs` — guided-auto issue queue preview helper.
- `skills/northstar/scripts/lib/project-viewer.mjs` — Project field/view diff helper.
- `skills/northstar/scripts/lib/recovery.mjs` — recovery action classifier.
- `skills/northstar/scripts/lib/report.mjs` — project completion report model builder.
- `skills/northstar/scripts/lib/doctor.mjs` — offline skill doctor.
- `skills/northstar/scripts/lib/platform.mjs` — safe argv command specs and local copy helpers.
- `skills/northstar/scripts/doctor.mjs` — CLI wrapper for doctor.
- `skills/northstar/scripts/sync-global.mjs` — local-to-global sync helper.

Modify:

- `package.json` — add skill scripts.
- `tests/index.test.ts` — import skill tests.

Create tests:

- `tests/skills/northstar-skill-files.test.ts`
- `tests/skills/northstar-operator-commands.test.ts`
- `tests/skills/northstar-execution-guide.test.ts`
- `tests/skills/northstar-project-viewer.test.ts`
- `tests/skills/northstar-recovery-report.test.ts`
- `tests/skills/northstar-local-consumer-simulation.test.ts`

---

### Task 1: Skill File Skeleton And Reference Coverage

**Files:**
- Create: `skills/northstar/SKILL.md`
- Create: `skills/northstar/README.md`
- Create: `skills/northstar/references/commands/plan.md`
- Create: `skills/northstar/references/commands/setup.md`
- Create: `skills/northstar/references/commands/execute.md`
- Create: `skills/northstar/references/commands/observe.md`
- Create: `skills/northstar/references/commands/recover.md`
- Create: `skills/northstar/references/commands/report.md`
- Create: `skills/northstar/references/issue-table-schema.md`
- Create: `skills/northstar/references/project-viewer.md`
- Create: `skills/northstar/references/safety-rules.md`
- Create: `skills/northstar/references/training-manual.md`
- Create: `tests/skills/northstar-skill-files.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing skill file test**

Create `tests/skills/northstar-skill-files.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(repoRoot, path), "utf8");
}

test("northstar skill documents phase commands and aliases", async () => {
  const skill = await readRepoFile("skills/northstar/SKILL.md");

  for (const command of [
    "/northstar-plan",
    "/northstar-setup",
    "/northstar-execute",
    "/northstar-observe",
    "/northstar-recover",
    "/northstar-report",
    "/northstar-init",
    "/northstar-watch",
    "/northstar-status",
    "/northstar-recovery",
    "/northstar-grill",
    "/northstar-to-spec",
    "/northstar-to-plan",
    "/northstar-to-issues",
  ]) {
    assert.match(skill, new RegExp(command.replace("/", "\\/")));
  }

  assert.match(skill, /phase workflow first/i);
  assert.match(skill, /Guided auto/i);
  assert.match(skill, /aggressive recovery with guards/i);
  assert.match(skill, /Do not write secrets/i);
});

test("northstar skill references every command detail file", async () => {
  const skill = await readRepoFile("skills/northstar/SKILL.md");

  for (const reference of [
    "references/commands/plan.md",
    "references/commands/setup.md",
    "references/commands/execute.md",
    "references/commands/observe.md",
    "references/commands/recover.md",
    "references/commands/report.md",
    "references/issue-table-schema.md",
    "references/project-viewer.md",
    "references/safety-rules.md",
    "references/training-manual.md",
  ]) {
    assert.match(skill, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const contents = await readRepoFile(`skills/northstar/${reference}`);
    assert.ok(contents.trim().length > 200, `${reference} should contain operational guidance`);
  }
});

test("northstar command references contain acceptance checklists", async () => {
  for (const command of ["plan", "setup", "execute", "observe", "recover", "report"]) {
    const contents = await readRepoFile(`skills/northstar/references/commands/${command}.md`);
    assert.match(contents, /^# /m);
    assert.match(contents, /## Intent/);
    assert.match(contents, /## Interaction Flow/);
    assert.match(contents, /## CLI Mapping/);
    assert.match(contents, /## Acceptance Checklist/);
  }
});
```

Modify `tests/index.test.ts` by adding:

```ts
import "./skills/northstar-skill-files.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `ENOENT` for `skills/northstar/SKILL.md` or the reference files.

- [ ] **Step 3: Create the minimal skill entrypoint**

Create `skills/northstar/SKILL.md`:

```md
---
name: northstar
description: Operate Northstar from a consumer repository using phase commands for planning, setup, execution, observability, recovery, and reporting.
---

# Northstar Skill

Use this skill when the user wants to plan, set up, execute, observe, recover, or report on Northstar automation from a consumer repository.

## Command Model

Northstar uses **phase workflow first**. Open the matching reference file before acting.

| Command | Reference |
| --- | --- |
| `/northstar-plan` | `references/commands/plan.md` |
| `/northstar-setup` | `references/commands/setup.md` |
| `/northstar-execute` | `references/commands/execute.md` |
| `/northstar-observe` | `references/commands/observe.md` |
| `/northstar-recover` | `references/commands/recover.md` |
| `/northstar-report` | `references/commands/report.md` |

## Common Aliases

| Alias | Use |
| --- | --- |
| `/northstar-init` | `/northstar-setup` |
| `/northstar-watch` | `/northstar-execute` |
| `/northstar-status` | `/northstar-observe` |
| `/northstar-recovery` | `/northstar-recover` |

## Planning Aliases

| Alias | Use |
| --- | --- |
| `/northstar-grill` | `/northstar-plan` grill mode |
| `/northstar-to-spec` | `/northstar-plan` spec mode |
| `/northstar-to-plan` | `/northstar-plan` implementation-plan mode |
| `/northstar-to-issues` | `/northstar-plan` issue-table mode |

## Required Shared References

- `references/issue-table-schema.md`
- `references/project-viewer.md`
- `references/safety-rules.md`
- `references/training-manual.md`

## Core Rules

- Treat the current directory as the consumer repository unless the user gives another path.
- Use Guided auto for `/northstar-execute`: show the issue queue before starting watch.
- Use aggressive recovery with guards for `/northstar-recover`: safe idempotent repairs may run automatically, risky worker/release actions require confirmation.
- Do not write secrets to config, docs, logs, SQLite history, worker prompts, GitHub Project fields, issue comments, or PR comments.
- Do not mutate GitHub Projects, fields, views, issues, PRs, branches, or release state without an explicit confirmation gate.
- Use Northstar CLI through explicit argv arrays and `--config` paths.
- Keep low-level CLI actions available as advanced operator actions, but do not make them the primary UX.
```

- [ ] **Step 4: Create command reference files**

Create `skills/northstar/references/commands/plan.md`:

```md
# /northstar-plan

## Intent

Use `/northstar-plan` to turn ideas, documents, specs, or implementation plans into Northstar-ready planning artifacts.

## Inputs

- Consumer repository path.
- Optional existing product notes, design docs, implementation plans, or GitHub issue links.
- User-selected planning mode.

## Interaction Flow

1. Ask which planning mode to use: grill, spec, plan, or issues.
2. For grill mode, ask one question at a time until risks and acceptance criteria are clear.
3. For spec mode, write a design document under `docs/specs`.
4. For implementation-plan mode, write a plan under `docs/plans`.
5. For issue-table mode, generate an issue table sized so each issue can fit one root session.
6. Dry-run issue generation before any GitHub mutation.
7. Ask for confirmation before applying GitHub issue creation.

## CLI Mapping

- `/northstar-to-issues` maps to `node --run northstar -- plan-issues --config <config> --spec <spec> --plan <plan> --dry-run`.
- Applying issues requires `--apply --confirm`.

## GitHub Project Behavior

Generated issues must include Project field values for Status, Northstar Lifecycle, Current Stage, Priority, Dependencies, PR URL, Merge SHA, Last Run At, and Recovery State.

## Recovery Behavior

If issue generation finds dependency cycles, oversized issues, missing acceptance criteria, or secret-shaped values, stop before mutation and report the exact blocker.

## Acceptance Checklist

- Planning mode selected.
- Issue rows contain title, body, acceptance criteria, priority, dependencies, labels, Project Status, Northstar Lifecycle, Current Stage, workflow id/domain, and suggested role.
- `northstar:ready` is only assigned to root-session-fit work.
- GitHub mutation requires confirmation.
```

Create `skills/northstar/references/commands/setup.md`:

```md
# /northstar-setup

## Intent

Use `/northstar-setup` to initialize or validate a consumer repository for Northstar.

## Inputs

- Consumer repository path.
- Optional `.northstar.yaml`.
- Optional GitHub Project URL or ID.

## Interaction Flow

1. Detect git root, default branch, and GitHub remote.
2. Locate `.northstar.yaml`; if missing, render a draft and ask before writing.
3. Validate GitHub credentials without printing tokens.
4. Validate Codex/OpenCode credential availability without printing secrets.
5. Validate workflow package, workflow id, roles, and host adapter config.
6. Diff required Project fields and views.
7. Ask before creating or repairing Project viewer resources.
8. Run the skill doctor.

## CLI Mapping

- `/northstar-setup` maps to `node skills/northstar/scripts/doctor.mjs --config <config>`.
- `/northstar-init` is an alias for `/northstar-setup`.

## GitHub Project Behavior

Project viewer setup is interactive. Missing fields or views must be shown as a diff before mutation.

## Recovery Behavior

Missing local config, missing Project fields, missing views, missing credentials, and missing workflow package are setup problems. Report them as actionable diagnostics.

## Acceptance Checklist

- Config path resolved.
- Doctor checks run offline.
- Missing Project resources shown as a diff.
- No secrets printed.
- No Project mutation without confirmation.
```

Create `skills/northstar/references/commands/execute.md`:

```md
# /northstar-execute

## Intent

Use `/northstar-execute` to run Northstar against ready issues with Guided auto.

## Inputs

- `.northstar.yaml` path.
- Optional issue number.
- Optional watch cycle limit.
- Optional non-interactive flag for future CI use.

## Interaction Flow

1. Load config.
2. Discover open GitHub issues labeled `northstar:ready`.
3. Exclude non-ready, closed, completed, and dependency-blocked issues.
4. Sort by dependency order, then priority, then issue number.
5. Display issue queue with issue number, title, priority, dependencies, workflow, role, host adapter, and release mode.
6. Ask for confirmation before starting watch or a single issue flow.
7. Execute using explicit argv arrays.
8. Record the selected command plan for reporting.

## CLI Mapping

- `/northstar-execute` maps to `node --run northstar -- watch --config <config>`.
- `/northstar-watch` is an alias for `/northstar-execute`.
- Advanced single-issue actions map to `intake`, `start`, `reconcile`, `release`, and `inspect`.

## GitHub Project Behavior

Before execution, show Project Status, Northstar Lifecycle, Current Stage, and dependency blockers for each candidate issue.

## Recovery Behavior

If dependency ordering is invalid, stop before watch and recommend `/northstar-recover` or issue dependency repair.

## Acceptance Checklist

- Queue preview produced before watch.
- Dependency ordering shown.
- Confirmation required before mutation.
- Command argv contains no shell-chain string.
```

Create `skills/northstar/references/commands/observe.md`:

```md
# /northstar-observe

## Intent

Use `/northstar-observe` to inspect current Northstar progress across runtime, GitHub issues, PRs, and Project viewer fields.

## Inputs

- `.northstar.yaml` path.
- Optional issue number.
- Optional Project URL or ID.

## Interaction Flow

1. Run runtime inspect summary.
2. Compare runtime lifecycle with GitHub issue labels.
3. Compare runtime lifecycle with GitHub Project Status and Northstar Lifecycle.
4. Check PR URL and Merge SHA evidence.
5. Report drift and next recommended action.

## CLI Mapping

- `/northstar-observe` maps to `node --run northstar -- inspect --config <config> --summary`.
- `/northstar-status` is an alias for `/northstar-observe`.

## GitHub Project Behavior

Report missing Project item, stale Status, stale Northstar Lifecycle, missing PR URL, and missing Merge SHA.

## Recovery Behavior

Observation is read-only. Recommend `/northstar-recover` when drift requires mutation.

## Acceptance Checklist

- Runtime status summarized.
- GitHub issue/PR/Project drift reported.
- No mutation performed.
- Next action is explicit.
```

Create `skills/northstar/references/commands/recover.md`:

```md
# /northstar-recover

## Intent

Use `/northstar-recover` to repair stuck, stale, or inconsistent Northstar runtime and GitHub projection state.

## Inputs

- `.northstar.yaml` path.
- Optional issue number.
- Optional recovery scope.

## Interaction Flow

1. Inspect runtime and GitHub evidence.
2. Classify recovery actions as safe automatic or confirmation-required.
3. Run safe idempotent repairs first.
4. Ask before worker rerun, verifier rerun, force release, issue close/reopen, or post-merge main mutation.
5. Report repaired, skipped, and blocked actions.

## CLI Mapping

- `/northstar-recover` maps to `node --run northstar -- repair-runtime --config <config>`.
- `/northstar-recovery` is an alias for `/northstar-recover`.
- Projection-only repair may map to `node --run northstar -- retry-sync --config <config> --issue <issue>`.

## GitHub Project Behavior

Safe repairs include adding missing Project item, updating stale Project fields, and syncing completed evidence.

## Recovery Behavior

Safe automatic repairs:

- projection repair
- stale Northstar label cleanup
- completed reconcile from closed issue plus merged PR
- existing branch or PR reuse
- retryable effect retry
- expired quarantined lease resume when safe

Confirmation-required repairs:

- rerun implementation worker
- rerun verifier
- force release or merge
- close or reopen issue
- mutate main after merge

## Acceptance Checklist

- Recovery actions classified.
- Safe repairs listed separately from risky repairs.
- Risky repairs require confirmation.
- Duplicate PR creation is avoided.
```

Create `skills/northstar/references/commands/report.md`:

```md
# /northstar-report

## Intent

Use `/northstar-report` to produce a project completion report with runtime, GitHub, verification, and recovery evidence.

## Inputs

- `.northstar.yaml` path.
- Optional issue list.
- Optional training manual flag.

## Interaction Flow

1. Gather runtime summary.
2. Gather issue, PR, and merge evidence.
3. Include dependency ordering result.
4. Include verification outputs provided by the run.
5. Include Project viewer consistency.
6. Include recovery actions and unresolved blockers.
7. Ask before creating training-manual output.

## CLI Mapping

- `/northstar-report` uses `node --run northstar -- inspect --config <config> --summary` plus local report aggregation.

## GitHub Project Behavior

Report Status, Northstar Lifecycle, Current Stage, PR URL, Merge SHA, Last Run At, and Recovery State consistency.

## Recovery Behavior

Reports do not mutate state. Recommend `/northstar-recover` for stale or missing evidence.

## Acceptance Checklist

- Project summary present.
- Issue, PR, and merge SHA evidence present.
- Verification result present when supplied.
- Recovery actions present.
- Unresolved blockers present.
```

- [ ] **Step 5: Create shared reference files**

Create concise but complete markdown files:

`skills/northstar/references/issue-table-schema.md`:

```md
# Northstar Issue Table Schema

Each generated issue row must include: title, body, acceptance criteria, quantitative metrics, priority, dependencies, labels, Project Status, Northstar Lifecycle, Current Stage, workflow id/domain, suggested role, and root_session_fit.

Rows with `root_session_fit=false` must not receive `northstar:ready`.

The issue body should be self-contained enough for one Northstar root session to execute without reading unrelated planning documents. Dependencies must use issue numbers when known and stable dependency keys during dry-run.
```

`skills/northstar/references/project-viewer.md`:

```md
# Northstar Project Viewer

Required fields: Status, Northstar Lifecycle, Current Stage, Priority, Dependencies, PR URL, Merge SHA, Last Run At, Recovery State.

Recommended views: Northstar Board, Active Runs, Blocked Recovery, Release Evidence, Completed.

The skill must report missing fields and views as a diff and ask before creating or repairing Project resources.

The default repair mode is interactive. GitHub API repair and Chrome automation repair are both mutations, so the skill must display the exact planned changes and wait for confirmation before applying them.
```

`skills/northstar/references/safety-rules.md`:

```md
# Northstar Safety Rules

Do not print or write secrets. Do not mutate GitHub without confirmation. Do not dispatch ready issues without a queue preview. Do not create duplicate PRs. Do not rerun workers during recovery without confirmation. Use argv arrays, not shell-chain command strings.

Safe read-only discovery may run before confirmation. Mutations include config writes, label changes, Project field updates, issue creation, PR creation, merge, release, worker rerun, and global skill sync.
```

`skills/northstar/references/training-manual.md`:

```md
# Northstar Training Manual Output

Training manual reports are optional. Include prompts used, setup decisions, issue table, execution summary, Project viewer evidence, recovery actions, verification output, and completion report.

The training manual should be generated only when the user asks for it or confirms the option during `/northstar-report`. It should not include tokens, credential values, private browser screenshots, or raw worker prompts containing secrets.
```

Create `skills/northstar/README.md`:

```md
# Northstar Skill

Use this skill from a consumer repository to plan, set up, execute, observe, recover, and report Northstar automation.

Run local checks:

```bash
npm run skill:doctor
```

Sync to the global skill directory:

```bash
npm run skill:sync
```
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test
```

Expected: this task's skill file tests PASS, later tasks may still be absent if imports have not been added yet.

- [ ] **Step 7: Commit**

```bash
git add skills/northstar/SKILL.md skills/northstar/README.md skills/northstar/references tests/skills/northstar-skill-files.test.ts tests/index.test.ts
git commit -m "docs: add northstar phase skill references"
```

---

### Task 2: Operator Command Mapping

**Files:**
- Create: `skills/northstar/scripts/lib/operator-commands.mjs`
- Create: `tests/skills/northstar-operator-commands.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing operator mapping tests**

Create `tests/skills/northstar-operator-commands.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const operator = await import("../../skills/northstar/scripts/lib/operator-commands.mjs");

test("phase commands and aliases resolve to stable argv arrays", () => {
  const configPath = "/repo/.northstar.yaml";
  const cases = [
    ["/northstar-setup", ["node", "--run", "northstar", "--", "doctor", "--config", configPath]],
    ["/northstar-init", ["node", "--run", "northstar", "--", "doctor", "--config", configPath]],
    ["/northstar-execute", ["node", "--run", "northstar", "--", "watch", "--config", configPath]],
    ["/northstar-watch", ["node", "--run", "northstar", "--", "watch", "--config", configPath]],
    ["/northstar-observe", ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]],
    ["/northstar-status", ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]],
    ["/northstar-recover", ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath]],
    ["/northstar-recovery", ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath]],
    ["/northstar-report", ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]],
  ] as const;

  for (const [intent, expectedArgv] of cases) {
    const plan = operator.commandPlanForIntent({ intent, configPath });
    assert.deepEqual(plan.argv, expectedArgv);
    assert.equal(plan.metadata.phase_command_mapped, 1);
  }
});

test("planning aliases resolve to northstar-plan modes", () => {
  const configPath = ".northstar.yaml";
  const cases = [
    ["/northstar-plan", "interactive"],
    ["/northstar-grill", "grill"],
    ["/northstar-to-spec", "spec"],
    ["/northstar-to-plan", "implementation-plan"],
    ["/northstar-to-issues", "issue-table"],
  ] as const;

  for (const [intent, mode] of cases) {
    const plan = operator.commandPlanForIntent({ intent, configPath, specPath: "docs/specs/a.md", planPath: "docs/plans/a.md" });
    assert.equal(plan.metadata.planning_mode, mode);
    assert.equal(plan.metadata.phase, "plan");
  }

  const issuePlan = operator.commandPlanForIntent({
    intent: "/northstar-to-issues",
    configPath,
    specPath: "docs/specs/a.md",
    planPath: "docs/plans/a.md",
  });
  assert.deepEqual(issuePlan.argv, [
    "node", "--run", "northstar", "--", "plan-issues",
    "--config", configPath,
    "--spec", "docs/specs/a.md",
    "--plan", "docs/plans/a.md",
    "--dry-run",
  ]);
});

test("advanced issue actions still require issue number", () => {
  assert.throws(
    () => operator.commandPlanForIntent({ intent: "start", configPath: ".northstar.yaml" }),
    Object.assign(new Error("NORTHSTAR_SKILL_ISSUE_REQUIRED"), { code: "NORTHSTAR_SKILL_ISSUE_REQUIRED" }),
  );

  const plan = operator.commandPlanForIntent({ intent: "release", configPath: ".northstar.yaml", issue: 42 });
  assert.deepEqual(plan.argv, ["node", "--run", "northstar", "--", "release", "--config", ".northstar.yaml", "--issue", "42"]);
});

test("watch options are validated", () => {
  const plan = operator.commandPlanForIntent({
    intent: "/northstar-watch",
    configPath: ".northstar.yaml",
    maxCycles: 3,
    logJson: true,
  });
  assert.deepEqual(plan.argv, [
    "node", "--run", "northstar", "--", "watch",
    "--config", ".northstar.yaml",
    "--max-cycles", "3",
    "--log-json",
  ]);

  assert.throws(
    () => operator.commandPlanForIntent({ intent: "/northstar-watch", configPath: ".northstar.yaml", maxCycles: 0 }),
    Object.assign(new Error("NORTHSTAR_SKILL_INVALID_WATCH_OPTION"), { code: "NORTHSTAR_SKILL_INVALID_WATCH_OPTION" }),
  );
});

test("unknown and missing config errors are stable", () => {
  assert.throws(
    () => operator.commandPlanForIntent({ intent: "/northstar-unknown", configPath: ".northstar.yaml" }),
    Object.assign(new Error("NORTHSTAR_SKILL_UNKNOWN_INTENT"), { code: "NORTHSTAR_SKILL_UNKNOWN_INTENT" }),
  );
  assert.throws(
    () => operator.commandPlanForIntent({ intent: "/northstar-status" }),
    Object.assign(new Error("NORTHSTAR_SKILL_CONFIG_REQUIRED"), { code: "NORTHSTAR_SKILL_CONFIG_REQUIRED" }),
  );
});
```

Modify `tests/index.test.ts`:

```ts
import "./skills/northstar-operator-commands.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because `operator-commands.mjs` does not exist.

- [ ] **Step 3: Implement operator command mapping**

Create `skills/northstar/scripts/lib/operator-commands.mjs`:

```js
export const ISSUE_REQUIRED_ERROR = "NORTHSTAR_SKILL_ISSUE_REQUIRED";
export const CONFIG_REQUIRED_ERROR = "NORTHSTAR_SKILL_CONFIG_REQUIRED";
export const INVALID_WATCH_OPTION_ERROR = "NORTHSTAR_SKILL_INVALID_WATCH_OPTION";
export const UNKNOWN_INTENT_ERROR = "NORTHSTAR_SKILL_UNKNOWN_INTENT";
export const PLAN_SOURCE_REQUIRED_ERROR = "NORTHSTAR_SKILL_PLAN_SOURCE_REQUIRED";

const phaseCommands = Object.freeze({
  "/northstar-setup": { phase: "setup", canonical: "/northstar-setup", cli: "doctor" },
  "/northstar-init": { phase: "setup", canonical: "/northstar-setup", cli: "doctor" },
  "/northstar-execute": { phase: "execute", canonical: "/northstar-execute", cli: "watch" },
  "/northstar-watch": { phase: "execute", canonical: "/northstar-execute", cli: "watch" },
  "/northstar-observe": { phase: "observe", canonical: "/northstar-observe", cli: "inspect-summary" },
  "/northstar-status": { phase: "observe", canonical: "/northstar-observe", cli: "inspect-summary" },
  "/northstar-recover": { phase: "recover", canonical: "/northstar-recover", cli: "repair-runtime" },
  "/northstar-recovery": { phase: "recover", canonical: "/northstar-recover", cli: "repair-runtime" },
  "/northstar-report": { phase: "report", canonical: "/northstar-report", cli: "inspect-summary" },
});

const planningAliases = Object.freeze({
  "/northstar-plan": "interactive",
  "/northstar-grill": "grill",
  "/northstar-to-spec": "spec",
  "/northstar-to-plan": "implementation-plan",
  "/northstar-to-issues": "issue-table",
});

const issueIntents = Object.freeze(["intake", "start", "reconcile", "release", "inspect"]);
const legacySkillIntents = Object.freeze({
  setup: "/northstar-setup",
  run: "/northstar-execute",
  watch: "/northstar-execute",
  status: "/northstar-observe",
  recover: "/northstar-recover",
  "plan issues": "/northstar-to-issues",
});

export const supportedOperatorIntents = Object.freeze([
  ...Object.keys(phaseCommands),
  ...Object.keys(planningAliases),
  ...Object.keys(legacySkillIntents),
  ...issueIntents,
]);

export function commandPlanForIntent(input = {}) {
  const rawIntent = normalizeIntent(input.intent);
  const configPath = normalizeConfigPath(input.configPath);

  if (planningAliases[rawIntent]) {
    return planningPlan(rawIntent, configPath, input);
  }

  const phaseIntent = legacySkillIntents[rawIntent] ?? rawIntent;
  if (phaseCommands[phaseIntent]) {
    return phasePlan(phaseIntent, configPath, input);
  }

  if (issueIntents.includes(rawIntent)) {
    return issuePlan(rawIntent, configPath, input);
  }

  throw newOperatorCommandError(UNKNOWN_INTENT_ERROR);
}

function planningPlan(intent, configPath, input) {
  const mode = planningAliases[intent];
  if (intent === "/northstar-to-issues") {
    const specPath = normalizeRequiredPath(input.specPath);
    const planPath = normalizeRequiredPath(input.planPath);
    return {
      argv: ["node", "--run", "northstar", "--", "plan-issues", "--config", configPath, "--spec", specPath, "--plan", planPath, "--dry-run"],
      metadata: { phase: "plan", planning_mode: mode, phase_command_mapped: 1 },
    };
  }

  return {
    argv: [],
    metadata: { phase: "plan", planning_mode: mode, phase_command_mapped: 1 },
  };
}

function phasePlan(intent, configPath, input) {
  const command = phaseCommands[intent];
  const argv = argvForCli(command.cli, configPath);

  if (command.cli === "watch") {
    appendWatchOptions(argv, input);
  }

  return {
    argv,
    metadata: {
      phase: command.phase,
      canonical_intent: command.canonical,
      phase_command_mapped: 1,
    },
  };
}

function issuePlan(intent, configPath, input) {
  return {
    argv: ["node", "--run", "northstar", "--", intent, "--config", configPath, "--issue", normalizeIssue(input.issue)],
    metadata: { phase: "advanced-issue-action", phase_command_mapped: 1 },
  };
}

function argvForCli(cli, configPath) {
  if (cli === "doctor") {
    return ["node", "--run", "northstar", "--", "doctor", "--config", configPath];
  }
  if (cli === "watch") {
    return ["node", "--run", "northstar", "--", "watch", "--config", configPath];
  }
  if (cli === "inspect-summary") {
    return ["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"];
  }
  if (cli === "repair-runtime") {
    return ["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath];
  }
  throw newOperatorCommandError(UNKNOWN_INTENT_ERROR);
}

function appendWatchOptions(argv, input) {
  if (input.maxCycles !== undefined) {
    argv.push("--max-cycles", normalizePositiveInteger(input.maxCycles, INVALID_WATCH_OPTION_ERROR));
  }

  if (input.logJson === true) {
    argv.push("--log-json");
  } else if (input.logJson !== undefined && input.logJson !== false) {
    throw newOperatorCommandError(INVALID_WATCH_OPTION_ERROR);
  }
}

function normalizeIntent(intent) {
  if (typeof intent === "string" && intent.trim() !== "") {
    return intent.trim();
  }
  throw newOperatorCommandError(UNKNOWN_INTENT_ERROR);
}

function normalizeConfigPath(configPath) {
  if (typeof configPath === "string" && configPath.trim() !== "") {
    return configPath;
  }
  throw newOperatorCommandError(CONFIG_REQUIRED_ERROR);
}

function normalizeRequiredPath(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw newOperatorCommandError(PLAN_SOURCE_REQUIRED_ERROR);
}

function normalizeIssue(issue) {
  return normalizePositiveInteger(issue, ISSUE_REQUIRED_ERROR);
}

function normalizePositiveInteger(value, errorCode) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  throw newOperatorCommandError(errorCode);
}

function newOperatorCommandError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: PASS for operator mapping tests.

- [ ] **Step 5: Commit**

```bash
git add skills/northstar/scripts/lib/operator-commands.mjs tests/skills/northstar-operator-commands.test.ts tests/index.test.ts
git commit -m "feat: map northstar phase skill commands"
```

---

### Task 3: Guided Execution Queue Helper

**Files:**
- Create: `skills/northstar/scripts/lib/execution-guide.mjs`
- Create: `tests/skills/northstar-execution-guide.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing guided execution tests**

Create `tests/skills/northstar-execution-guide.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const guide = await import("../../skills/northstar/scripts/lib/execution-guide.mjs");

test("guided execution preview filters and orders ready issues", () => {
  const preview = guide.buildGuidedExecutionPreview({
    config: {
      workflowId: "issue_to_pr_release",
      hostAdapter: "codex",
      autoRelease: true,
    },
    issues: [
      { number: 4, title: "blocked", state: "open", labels: ["northstar:ready"], priority: "P0", dependencies: [2] },
      { number: 2, title: "base", state: "open", labels: ["northstar:ready"], priority: "P1", dependencies: [] },
      { number: 3, title: "closed", state: "closed", labels: ["northstar:ready"], priority: "P0", dependencies: [] },
      { number: 1, title: "not ready", state: "open", labels: [], priority: "P0", dependencies: [] },
    ],
    completedIssueNumbers: [],
  });

  assert.deepEqual(preview.queue.map((item: { issueNumber: number }) => item.issueNumber), [2]);
  assert.deepEqual(preview.blocked.map((item: { issueNumber: number }) => item.issueNumber), [4]);
  assert.equal(preview.ignored.length, 2);
  assert.equal(preview.metrics.guided_ready_issues_discovered, 2);
  assert.equal(preview.metrics.guided_dependency_blocked_issues, 1);
  assert.equal(preview.confirmationRequired, true);
});

test("dependency ordering admits issue after dependency completion", () => {
  const preview = guide.buildGuidedExecutionPreview({
    config: {
      workflowId: "issue_to_pr_release",
      hostAdapter: "opencode",
      autoRelease: false,
    },
    issues: [
      { number: 4, title: "next", state: "open", labels: ["northstar:ready"], priority: "P0", dependencies: [2] },
      { number: 2, title: "done", state: "closed", labels: ["northstar:completed"], priority: "P1", dependencies: [] },
    ],
    completedIssueNumbers: [2],
  });

  assert.deepEqual(preview.queue.map((item: { issueNumber: number }) => item.issueNumber), [4]);
  assert.equal(preview.queue[0].hostAdapter, "opencode");
  assert.equal(preview.queue[0].releaseMode, "manual");
});
```

Modify `tests/index.test.ts`:

```ts
import "./skills/northstar-execution-guide.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because `execution-guide.mjs` does not exist.

- [ ] **Step 3: Implement guided execution helper**

Create `skills/northstar/scripts/lib/execution-guide.mjs`:

```js
const READY_LABEL = "northstar:ready";
const COMPLETED_LABEL = "northstar:completed";

const priorityRank = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

export function buildGuidedExecutionPreview(input = {}) {
  const config = normalizeConfig(input.config);
  const completed = new Set(input.completedIssueNumbers ?? []);
  const issues = Array.isArray(input.issues) ? input.issues : [];

  const candidates = [];
  const blocked = [];
  const ignored = [];

  for (const issue of issues) {
    const normalized = normalizeIssue(issue, config);
    if (normalized.state !== "open" || normalized.labels.includes(COMPLETED_LABEL) || !normalized.labels.includes(READY_LABEL)) {
      ignored.push({ issueNumber: normalized.issueNumber, reason: ignoredReason(normalized) });
      continue;
    }

    const missingDependencies = normalized.dependencies.filter((dependency) => !completed.has(dependency));
    if (missingDependencies.length > 0) {
      blocked.push({ ...normalized, missingDependencies });
      continue;
    }

    candidates.push(normalized);
  }

  candidates.sort(compareQueueItems);

  return {
    queue: candidates,
    blocked,
    ignored,
    confirmationRequired: true,
    metrics: {
      guided_ready_issues_discovered: candidates.length + blocked.length,
      guided_dependency_blocked_issues: blocked.length,
      guided_ignored_issues: ignored.length,
      guided_queue_size: candidates.length,
    },
  };
}

function normalizeConfig(config = {}) {
  return {
    workflowId: stringOr(config.workflowId, "issue_to_pr_release"),
    hostAdapter: stringOr(config.hostAdapter, "codex"),
    autoRelease: config.autoRelease === true,
  };
}

function normalizeIssue(issue = {}, config) {
  return {
    issueNumber: Number(issue.number),
    title: stringOr(issue.title, ""),
    state: stringOr(issue.state, "open"),
    labels: Array.isArray(issue.labels) ? issue.labels.map(String) : [],
    priority: stringOr(issue.priority, "P2"),
    dependencies: Array.isArray(issue.dependencies) ? issue.dependencies.map(Number).filter(Number.isInteger) : [],
    workflowId: stringOr(issue.workflowId, config.workflowId),
    role: stringOr(issue.role, "issue_worker"),
    hostAdapter: stringOr(issue.hostAdapter, config.hostAdapter),
    releaseMode: config.autoRelease ? "auto" : "manual",
  };
}

function ignoredReason(issue) {
  if (issue.state !== "open") {
    return "not_open";
  }
  if (issue.labels.includes(COMPLETED_LABEL)) {
    return "completed";
  }
  return "not_ready";
}

function compareQueueItems(left, right) {
  return rankPriority(left.priority) - rankPriority(right.priority) || left.issueNumber - right.issueNumber;
}

function rankPriority(priority) {
  return priorityRank[priority] ?? 99;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: PASS for guided execution tests.

- [ ] **Step 5: Commit**

```bash
git add skills/northstar/scripts/lib/execution-guide.mjs tests/skills/northstar-execution-guide.test.ts tests/index.test.ts
git commit -m "feat: preview northstar guided execution queue"
```

---

### Task 4: Project Viewer Diff Helper

**Files:**
- Create: `skills/northstar/scripts/lib/project-viewer.mjs`
- Create: `tests/skills/northstar-project-viewer.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing Project viewer tests**

Create `tests/skills/northstar-project-viewer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const projectViewer = await import("../../skills/northstar/scripts/lib/project-viewer.mjs");

test("project viewer diff reports missing fields and views", () => {
  const diff = projectViewer.diffProjectViewer({
    fields: ["Status", "Priority"],
    views: ["Northstar Board"],
  });

  assert.deepEqual(diff.missingFields, [
    "Northstar Lifecycle",
    "Current Stage",
    "Dependencies",
    "PR URL",
    "Merge SHA",
    "Last Run At",
    "Recovery State",
  ]);
  assert.deepEqual(diff.missingViews, ["Active Runs", "Blocked Recovery", "Release Evidence", "Completed"]);
  assert.equal(diff.requiresConfirmation, true);
});

test("complete project viewer has no missing resources", () => {
  const diff = projectViewer.diffProjectViewer({
    fields: projectViewer.REQUIRED_PROJECT_FIELDS,
    views: projectViewer.RECOMMENDED_PROJECT_VIEWS,
  });

  assert.deepEqual(diff.missingFields, []);
  assert.deepEqual(diff.missingViews, []);
  assert.equal(diff.requiresConfirmation, false);
});
```

Modify `tests/index.test.ts`:

```ts
import "./skills/northstar-project-viewer.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because `project-viewer.mjs` does not exist.

- [ ] **Step 3: Implement Project viewer helper**

Create `skills/northstar/scripts/lib/project-viewer.mjs`:

```js
export const REQUIRED_PROJECT_FIELDS = Object.freeze([
  "Status",
  "Northstar Lifecycle",
  "Current Stage",
  "Priority",
  "Dependencies",
  "PR URL",
  "Merge SHA",
  "Last Run At",
  "Recovery State",
]);

export const RECOMMENDED_PROJECT_VIEWS = Object.freeze([
  "Northstar Board",
  "Active Runs",
  "Blocked Recovery",
  "Release Evidence",
  "Completed",
]);

export function diffProjectViewer(project = {}) {
  const fields = new Set((project.fields ?? []).map(String));
  const views = new Set((project.views ?? []).map(String));
  const missingFields = REQUIRED_PROJECT_FIELDS.filter((field) => !fields.has(field));
  const missingViews = RECOMMENDED_PROJECT_VIEWS.filter((view) => !views.has(view));

  return {
    missingFields,
    missingViews,
    requiresConfirmation: missingFields.length > 0 || missingViews.length > 0,
    metrics: {
      project_viewer_missing_fields: missingFields.length,
      project_viewer_missing_views: missingViews.length,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: PASS for Project viewer tests.

- [ ] **Step 5: Commit**

```bash
git add skills/northstar/scripts/lib/project-viewer.mjs tests/skills/northstar-project-viewer.test.ts tests/index.test.ts
git commit -m "feat: diff northstar project viewer resources"
```

---

### Task 5: Recovery Classification And Report Builder

**Files:**
- Create: `skills/northstar/scripts/lib/recovery.mjs`
- Create: `skills/northstar/scripts/lib/report.mjs`
- Create: `tests/skills/northstar-recovery-report.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing recovery/report tests**

Create `tests/skills/northstar-recovery-report.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const recovery = await import("../../skills/northstar/scripts/lib/recovery.mjs");
const report = await import("../../skills/northstar/scripts/lib/report.mjs");

test("recovery classifier separates safe and confirmation-required actions", () => {
  const plan = recovery.classifyRecoveryActions([
    "project_item_missing",
    "stale_project_fields",
    "completed_reconcile",
    "rerun_worker",
    "force_release",
  ]);

  assert.deepEqual(plan.safeAutomatic.map((action: { type: string }) => action.type), [
    "project_item_missing",
    "stale_project_fields",
    "completed_reconcile",
  ]);
  assert.deepEqual(plan.requiresConfirmation.map((action: { type: string }) => action.type), [
    "rerun_worker",
    "force_release",
  ]);
  assert.equal(plan.metrics.recovery_safe_actions, 3);
  assert.equal(plan.metrics.recovery_confirmation_required_actions, 2);
});

test("project completion report preserves evidence and unresolved blockers", () => {
  const summary = report.buildProjectCompletionReport({
    repo: "paulpai0412/example",
    projectUrl: "https://github.com/orgs/paulpai0412/projects/1",
    issues: [{ number: 1, url: "https://github.com/paulpai0412/example/issues/1", lifecycle: "completed" }],
    prs: [{ number: 2, url: "https://github.com/paulpai0412/example/pull/2", mergeSha: "abc123" }],
    dependencyOrdering: { violations: 0 },
    verification: { npmTest: "passed" },
    recoveryActions: [{ type: "stale_project_fields", status: "repaired" }],
    unresolvedBlockers: [],
  });

  assert.equal(summary.repo, "paulpai0412/example");
  assert.equal(summary.metrics.report_issues_completed, 1);
  assert.equal(summary.metrics.report_prs_merged, 1);
  assert.equal(summary.metrics.report_unresolved_blockers, 0);
  assert.equal(summary.prs[0].mergeSha, "abc123");
});
```

Modify `tests/index.test.ts`:

```ts
import "./skills/northstar-recovery-report.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because `recovery.mjs` and `report.mjs` do not exist.

- [ ] **Step 3: Implement recovery classifier**

Create `skills/northstar/scripts/lib/recovery.mjs`:

```js
const safeAutomaticTypes = new Set([
  "project_item_missing",
  "stale_project_fields",
  "stale_lifecycle_labels",
  "completed_projection_retry",
  "completed_reconcile",
  "reuse_existing_branch",
  "reuse_existing_pr",
  "retry_retryable_effect",
  "resume_expired_quarantine",
]);

const confirmationRequiredTypes = new Set([
  "rerun_worker",
  "rerun_verifier",
  "force_release",
  "close_issue",
  "reopen_issue",
  "post_merge_main_mutation",
]);

export function classifyRecoveryActions(actionTypes = []) {
  const safeAutomatic = [];
  const requiresConfirmation = [];
  const unknown = [];

  for (const type of actionTypes) {
    const action = { type: String(type) };
    if (safeAutomaticTypes.has(action.type)) {
      safeAutomatic.push(action);
    } else if (confirmationRequiredTypes.has(action.type)) {
      requiresConfirmation.push(action);
    } else {
      unknown.push(action);
    }
  }

  return {
    safeAutomatic,
    requiresConfirmation,
    unknown,
    metrics: {
      recovery_safe_actions: safeAutomatic.length,
      recovery_confirmation_required_actions: requiresConfirmation.length,
      recovery_unknown_actions: unknown.length,
    },
  };
}
```

- [ ] **Step 4: Implement report builder**

Create `skills/northstar/scripts/lib/report.mjs`:

```js
export function buildProjectCompletionReport(input = {}) {
  const issues = Array.isArray(input.issues) ? input.issues : [];
  const prs = Array.isArray(input.prs) ? input.prs : [];
  const recoveryActions = Array.isArray(input.recoveryActions) ? input.recoveryActions : [];
  const unresolvedBlockers = Array.isArray(input.unresolvedBlockers) ? input.unresolvedBlockers : [];

  return {
    repo: input.repo ?? "",
    projectUrl: input.projectUrl ?? "",
    issues,
    prs,
    dependencyOrdering: input.dependencyOrdering ?? { violations: 0 },
    verification: input.verification ?? {},
    recoveryActions,
    unresolvedBlockers,
    metrics: {
      report_issues_completed: issues.filter((issue) => issue.lifecycle === "completed").length,
      report_prs_merged: prs.filter((pr) => typeof pr.mergeSha === "string" && pr.mergeSha.length > 0).length,
      report_recovery_actions: recoveryActions.length,
      report_unresolved_blockers: unresolvedBlockers.length,
      report_dependency_ordering_violations: Number(input.dependencyOrdering?.violations ?? 0),
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test
```

Expected: PASS for recovery/report tests.

- [ ] **Step 6: Commit**

```bash
git add skills/northstar/scripts/lib/recovery.mjs skills/northstar/scripts/lib/report.mjs tests/skills/northstar-recovery-report.test.ts tests/index.test.ts
git commit -m "feat: classify northstar skill recovery and reports"
```

---

### Task 6: Doctor, Platform, Global Sync, And Package Scripts

**Files:**
- Create: `skills/northstar/scripts/lib/platform.mjs`
- Create: `skills/northstar/scripts/lib/doctor.mjs`
- Create: `skills/northstar/scripts/doctor.mjs`
- Create: `skills/northstar/scripts/sync-global.mjs`
- Create: `skills/northstar/templates/northstar.yaml`
- Create: `skills/northstar/templates/workflow.issue-to-pr-release.yaml`
- Create: `tests/skills/northstar-local-consumer-simulation.test.ts`
- Modify: `package.json`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing local simulation tests**

Create `tests/skills/northstar-local-consumer-simulation.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const platform = await import("../../skills/northstar/scripts/lib/platform.mjs");
const doctor = await import("../../skills/northstar/scripts/lib/doctor.mjs");
const syncGlobal = await import("../../skills/northstar/scripts/sync-global.mjs");

test("commandSpec rejects shell-chain command strings", () => {
  assert.throws(() => platform.commandSpec("git status && rm -rf x", []), /NORTHSTAR_SKILL_SHELL_CHAIN_REJECTED/);
  assert.deepEqual(platform.commandSpec("git", ["status"]).argv, ["git", "status"]);
});

test("doctor verifies local skill references without network or host credentials", async () => {
  const result = await doctor.runDoctor({
    cwd: process.cwd(),
    env: {},
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });

  assert.equal(result.metrics.skill_doctor_checks_failed, 0);
  assert.equal(result.metrics.skill_doctor_reference_files_checked >= 10, true);
});

test("sync global copies skill files to an explicit target", async () => {
  const target = await mkdtemp(join(tmpdir(), "northstar-skill-global-"));
  try {
    const result = await syncGlobal.syncGlobalSkill({ targetDir: target });
    const skill = await readFile(join(target, "SKILL.md"), "utf8");
    assert.match(skill, /Northstar Skill/);
    assert.equal(result.skill_global_sync_overwrites_target, 1);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
```

Modify `tests/index.test.ts`:

```ts
import "./skills/northstar-local-consumer-simulation.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because platform, doctor, sync-global, templates, or package scripts do not exist.

- [ ] **Step 3: Implement platform helper**

Create `skills/northstar/scripts/lib/platform.mjs`:

```js
import { cp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

const shellChainPattern = /&&|\|\||;/;

export function commandSpec(command, args = []) {
  if (typeof command !== "string" || command.trim() === "" || shellChainPattern.test(command)) {
    throw new Error("NORTHSTAR_SKILL_SHELL_CHAIN_REJECTED");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || shellChainPattern.test(arg))) {
    throw new Error("NORTHSTAR_SKILL_SHELL_CHAIN_REJECTED");
  }
  return { command, args, argv: [command, ...args] };
}

export async function copyDirectoryOverwrite(sourceDir, targetDir) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

export function globalSkillDirForHome({ platform, home }) {
  if (platform === "win32") {
    return join(home, ".codex", "skills", "northstar");
  }
  return join(home, ".codex", "skills", "northstar");
}
```

- [ ] **Step 4: Implement doctor**

Create `skills/northstar/scripts/lib/doctor.mjs`:

```js
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const referenceFiles = Object.freeze([
  "SKILL.md",
  "README.md",
  "references/commands/plan.md",
  "references/commands/setup.md",
  "references/commands/execute.md",
  "references/commands/observe.md",
  "references/commands/recover.md",
  "references/commands/report.md",
  "references/issue-table-schema.md",
  "references/project-viewer.md",
  "references/safety-rules.md",
  "references/training-manual.md",
]);

export async function runDoctor(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const skillRoot = options.skillRoot ?? resolve(cwd, "skills/northstar");
  const checks = [];

  for (const file of referenceFiles) {
    const path = join(skillRoot, file);
    checks.push(await fileCheck(file, path));
  }

  const failed = checks.filter((check) => check.status !== "ok").length;
  return {
    checks,
    metrics: {
      skill_doctor_reference_files_checked: checks.length,
      skill_doctor_checks_failed: failed,
    },
  };
}

async function fileCheck(id, path) {
  try {
    await access(path);
    return { id, status: "ok", message: `${id} exists` };
  } catch {
    return { id, status: "missing", message: `${id} is missing` };
  }
}
```

Create `skills/northstar/scripts/doctor.mjs`:

```js
import { pathToFileURL } from "node:url";
import { runDoctor } from "./lib/doctor.mjs";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDoctor();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.metrics.skill_doctor_checks_failed === 0 ? 0 : 1;
}
```

- [ ] **Step 5: Implement sync-global**

Create `skills/northstar/scripts/sync-global.mjs`:

```js
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { copyDirectoryOverwrite, globalSkillDirForHome } from "./lib/platform.mjs";

export function defaultSourceDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveSyncTarget({ platform = process.platform, home = homedir(), targetDir } = {}) {
  return targetDir ?? globalSkillDirForHome({ platform, home });
}

export async function syncGlobalSkill({ sourceDir = defaultSourceDir(), targetDir = resolveSyncTarget() } = {}) {
  await copyDirectoryOverwrite(sourceDir, targetDir);
  return { sourceDir, targetDir, skill_global_sync_overwrites_target: 1 };
}

export function parseSyncGlobalArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--target") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const targetDir = args[index + 1];
    if (targetDir === undefined || targetDir.startsWith("--")) {
      throw new Error("Missing value for --target");
    }
    parsed.targetDir = targetDir;
    index += 1;
  }
  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseSyncGlobalArgs(process.argv.slice(2));
  const result = await syncGlobalSkill(options);
  console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 6: Add templates and package scripts**

Create `skills/northstar/templates/northstar.yaml`:

```yaml
schema_version: "1"
project:
  name: "__PROJECT_NAME__"
  root: "__PROJECT_ROOT__"
runtime:
  db_path: ".northstar/runtime/control-plane.sqlite3"
  host_adapter: "codex"
  development_capacity: 1
  release_capacity: 1
  auto_release: true
workflow:
  package: "./.northstar/workflows/issue-to-pr-release.yaml"
  id: "issue_to_pr_release"
github:
  repo: "__GITHUB_REPO__"
  intake:
    enabled: true
    label: "northstar:ready"
  project:
    enabled: false
```

Create `skills/northstar/templates/workflow.issue-to-pr-release.yaml`:

```yaml
id: issue_to_pr_release
version: "1"
domain: software_development
roles:
  issue_worker:
    host: codex
  pr_verifier:
    host: codex
  release_worker:
    host: codex
stages:
  - name: implementation
    role: issue_worker
    target_lifecycle: running
  - name: verification
    role: pr_verifier
    target_lifecycle: verifying
  - name: release
    role: release_worker
    target_lifecycle: release_pending
```

Modify `package.json` scripts:

```json
"skill:doctor": "node skills/northstar/scripts/doctor.mjs",
"skill:sync": "node skills/northstar/scripts/sync-global.mjs"
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test
```

Expected: PASS for local consumer simulation tests.

- [ ] **Step 8: Commit**

```bash
git add package.json skills/northstar/scripts skills/northstar/templates tests/skills/northstar-local-consumer-simulation.test.ts tests/index.test.ts
git commit -m "feat: add northstar skill doctor and sync"
```

---

### Task 7: Final Verification Gate

**Files:**
- Verify only.

- [ ] **Step 1: Run full offline test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run skill doctor**

Run:

```bash
npm run skill:doctor
```

Expected: JSON output with:

```json
{
  "metrics": {
    "skill_doctor_checks_failed": 0
  }
}
```

- [ ] **Step 3: Run explicit global sync simulation**

Run:

```bash
node skills/northstar/scripts/sync-global.mjs --target /tmp/northstar-global-skill-check
```

Expected: JSON output includes:

```json
{
  "skill_global_sync_overwrites_target": 1
}
```

- [ ] **Step 4: Verify no live credential dependency**

Run:

```bash
rg "GITHUB_TOKEN|NORTHSTAR_PRODUCTION_LIVE|NORTHSTAR_FULL_LIVE|OPENAI_API_KEY|OPENCODE" skills/northstar tests/skills
```

Expected: either no matches or matches only in prose explaining that live credentials are not required.

- [ ] **Step 5: Verify no shell-chain command specs**

Run:

```bash
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|argv: \\[[^\\n]*(?:&&|\\|\\||;)" skills/northstar/scripts
```

Expected: no shell-chain runtime command construction in source. The `platform.mjs` rejection regex and tests may contain shell-chain literals, but command construction must use argv arrays.

- [ ] **Step 6: Check git status**

Run:

```bash
git status --short
```

Expected: only intended implementation files are modified or untracked.

- [ ] **Step 7: Final commit**

If any verification-only adjustments were needed:

```bash
git add skills/northstar tests/skills tests/index.test.ts package.json
git commit -m "test: verify northstar phase skill workflow"
```

---

## Requirement Coverage Matrix

| Requirement | Task |
| --- | --- |
| AC-SKILL-01: `SKILL.md` documents six primary phase commands | Task 1 |
| AC-SKILL-02: common aliases documented | Task 1 |
| AC-SKILL-03: planning aliases documented | Task 1 |
| AC-SKILL-04: each primary command has a reference file | Task 1 |
| AC-SKILL-05: skill tells agent which reference file to read | Task 1 |
| AC-SKILL-06: operator mapping resolves primary commands | Task 2 |
| AC-SKILL-07: operator mapping resolves aliases | Task 2 |
| AC-SKILL-08: planning aliases resolve to `/northstar-plan` modes | Task 2 |
| AC-SKILL-09: unknown command returns stable error | Task 2 |
| AC-SKILL-10: low-level issue actions remain available | Task 2 |
| AC-SKILL-11: execute produces queue before watch | Task 3 |
| AC-SKILL-12: queue includes required issue/workflow fields | Task 3 |
| AC-SKILL-13: execution requires confirmation | Task 3 |
| AC-SKILL-14: dependency ordering shown before execution | Task 3 |
| AC-SKILL-15: recovery distinguishes safe vs risky repairs | Task 5 |
| AC-SKILL-16: safe repairs represented | Task 5 |
| AC-SKILL-17: risky repairs require confirmation | Task 5 |
| AC-SKILL-18: setup/observe detects missing Project fields | Task 4 |
| AC-SKILL-19: missing Project resources reported as diff | Task 4 |
| AC-SKILL-20: Project repair requires confirmation | Task 4 |
| AC-SKILL-21: report produces project summary and evidence | Task 5 |
| AC-SKILL-22: training manual output optional | Task 1 |
| AC-SKILL-23: tests cover parser and alias mapping | Task 2 |
| AC-SKILL-24: tests cover reference file presence | Task 1 |
| AC-SKILL-25: tests cover local consumer repo simulation | Task 6 |
| AC-SKILL-26: offline tests require no credentials/network | Task 6, Task 7 |
| AC-SKILL-27: global skill sync preserves command map | Task 6 |
| AC-SKILL-28: doctor verifies synced skill usability | Task 6, Task 7 |

## Deferred Work

- Live GitHub Project mutation verification.
- Chrome automation for Project view creation/repair.
- Real SDK worker execution through the skill.
- Browser screenshots for skill-operated UAT.
- npm publish or OS packaging.
