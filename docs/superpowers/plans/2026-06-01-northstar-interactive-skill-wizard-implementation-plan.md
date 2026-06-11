# Northstar Interactive Skill Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive ask-question workflow to the Northstar skill so users can drive a consumer project from initialization through issue execution, monitoring, recovery, and completion reporting.

**Architecture:** Keep the feature in the skill layer. Add deterministic text tests that verify the skill requires one question at a time, option-based choices, mutation gates, monitoring, recovery, and completion reporting. Do not change runtime, orchestrator, GitHub adapters, or CLI behavior.

**Tech Stack:** Markdown skill instructions, Node `node:test`, existing skill sync and doctor scripts.

---

### Task 1: Add Skill Contract Tests

**Files:**
- Modify: `tests/skills/northstar-skill-files.test.ts`
- Modify: `skills/northstar/SKILL.md`

- [ ] **Step 1: Write failing tests**

Add tests that assert `skills/northstar/SKILL.md` contains:
- `Interactive Ask-Question Workflow`
- one-question-at-a-time rule
- option labels for project initialization, GitHub setup, Project viewer, issue creation, scheduling, execution, monitoring, recovery, and completion report
- explicit mutation gates before writing config, creating issues, or mutating GitHub Project

- [ ] **Step 2: Verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/northstar-skill-files.test.ts
```

Expected: FAIL because the current skill lacks the interactive wizard section.

- [ ] **Step 3: Update skill**

Add a concise `Interactive Ask-Question Workflow` section to `skills/northstar/SKILL.md`. It must instruct Codex to ask one short multiple-choice question at a time and wait for the user's answer before continuing.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/northstar-skill-files.test.ts
```

Expected: PASS.

### Task 2: Sync And Verify

**Files:**
- Modify: global skill target via `npm run skill:sync`

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Sync global skill**

Run:

```bash
npm run skill:sync
```

Expected: `skill_global_sync_overwrites_target=1`.

- [ ] **Step 3: Run doctor**

Run:

```bash
npm run skill:doctor -- --json
```

Expected: platform, sqlite, git, gh, credential, northstar root, CLI, and SDK checks pass. Missing consumer `.northstar.yaml` is acceptable when running from the Northstar repo itself.
