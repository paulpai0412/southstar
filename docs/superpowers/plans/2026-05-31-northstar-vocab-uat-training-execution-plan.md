# Northstar Vocabulary UAT Training Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a real, non-simulated Northstar UAT that creates a new English vocabulary consumer repo, drives development through real GitHub issues/Project/PRs and Northstar software-development automation, verifies the finished app in a real browser, and produces an education training manual.

**Architecture:** The Northstar repository is the tool provider and training-manual home. The consumer repository `paulpai0412/northstar-vocab-uat` is the real target app. All consumer-repo automation must be initiated as Northstar skill operations; the skill may invoke `gh`, `git`, `node --run northstar`, and browser tooling internally, but the UAT evidence must prove the path used real GitHub, real local worktrees, real SDK workers, real PR merges, and real browser verification.

**Tech Stack:** Northstar CLI/skill, GitHub CLI/API, GitHub Projects v2, git worktrees, Codex SDK host path, Vite + React + TypeScript consumer app, Vitest coverage, Playwright or Codex Browser for real browser UAT.

---

## Non-Negotiable Execution Rules

- This is a real UAT, not a smoke test.
- Do not satisfy any acceptance criterion with fake GitHub gateways, fake host adapters, fake domain drivers, fake PRs, simulated merges, or mocked browser journeys.
- Use `paulpai0412/northstar-vocab-uat` as the live consumer repo.
- Use real GitHub issue creation, Project setup, labels, branches, PRs, merges, and issue closures.
- Use real Northstar production CLI/watch dependency wiring.
- Use real local issue worktrees under the consumer repo `.northstar/runtime/worktrees`.
- Use Codex as the primary worker host. OpenCode may be documented as an override but is not required to pass this UAT.
- Use a real browser for final app verification. A DOM-only unit test does not satisfy browser UAT.
- Consumer app automated coverage must be at least 90% for lines, branches, functions, and statements.
- Northstar repository `npm run test:coverage` must pass its configured gate before the UAT is reported complete.
- Do not write secrets to repository files, docs, issues, Project fields, PR comments, logs, SQLite history, or worker prompts.
- Do not commit `.superpowers/brainstorm/**` or local `.codex/config.toml`.

## Files And Artifacts

Northstar repository:

- Read: `docs/superpowers/specs/2026-05-31-northstar-vocab-uat-training-design.md`
- Create: `docs/training/northstar-vocab-uat-training-manual.md`
- Create: `docs/training/northstar-vocab-uat-metrics.json`

Consumer repository:

- Create remotely: `paulpai0412/northstar-vocab-uat`
- Create locally: `/home/timmypai/apps/northstar-vocab-uat`
- Create: `.northstar.yaml`
- Create through Northstar-managed issues and PRs:
  - `package.json`
  - `index.html`
  - `src/main.tsx`
  - `src/App.tsx`
  - `src/data/vocabulary.ts`
  - `src/lib/progress.ts`
  - `src/lib/quiz.ts`
  - `src/styles.css`
  - `tests/unit/vocabulary.test.ts`
  - `tests/unit/progress.test.ts`
  - `tests/unit/quiz.test.ts`
  - `tests/e2e/vocab-flow.spec.ts`
  - `vitest.config.ts`
  - `playwright.config.ts`
  - `README.md`

## Required Environment

The executor must verify these without printing secret values:

```bash
gh auth status
gh auth token >/dev/null
node --run northstar -- --help
node --run northstar -- watch --help
```

During live Northstar execution, use:

```bash
GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_ROOT="/home/timmypai/apps/northstar"
```

The token must only exist in the process environment.

## Task 1: Preflight Real UAT Readiness

**Files:**
- Read: `skills/northstar/SKILL.md`
- Read: `package.json`
- Create: `docs/training/northstar-vocab-uat-training-manual.md`
- Create: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Record the UAT start in the manual**

Create `docs/training/northstar-vocab-uat-training-manual.md` with this initial content:

```markdown
# Northstar Vocabulary UAT Training Manual

Date: 2026-05-31

## 1. Overview And Goals

This manual records a real Northstar UAT executed against the consumer repository `paulpai0412/northstar-vocab-uat`.

The UAT goal is to use the Northstar skill to create a GitHub Project, create ordered GitHub issues, run Northstar software-development automation, merge real PRs, close real issues, verify the finished English vocabulary web app in a real browser, and document the process for future operators.

## 2. Evidence Log

| Time | Operator Intent | Northstar Skill Action | Evidence | Result |
| --- | --- | --- | --- | --- |
```

- [ ] **Step 2: Create the initial metrics file**

Create `docs/training/northstar-vocab-uat-metrics.json` with this content:

```json
{
  "uat_consumer_repos_created": 0,
  "uat_project_created_or_reused": 0,
  "uat_project_fields_configured": 0,
  "uat_project_views_configured": 0,
  "uat_issues_created": 0,
  "uat_dependency_edges_created": 0,
  "uat_dependency_order_violations": 0,
  "uat_ready_labeled_issues": 0,
  "uat_northstar_completed_issues": 0,
  "uat_prs_created_or_reused": 0,
  "uat_prs_merged": 0,
  "uat_github_issues_closed": 0,
  "uat_project_lifecycle_updates": 0,
  "uat_progress_comments_created": 0,
  "uat_manual_recovery_actions": 0,
  "uat_duplicate_prs_created": 0,
  "uat_secret_leaks": 0,
  "uat_training_manual_sections_completed": 2,
  "uat_browser_study_flow_passed": 0,
  "vocab_seed_words": 0,
  "practice_words_studied": 0,
  "quiz_questions_answered": 0,
  "progress_updates_recorded": 0,
  "review_queue_items_visible": 0,
  "desktop_viewport_verified": 0,
  "mobile_viewport_verified": 0,
  "consumer_coverage_lines": 0,
  "consumer_coverage_branches": 0,
  "consumer_coverage_functions": 0,
  "consumer_coverage_statements": 0
}
```

- [ ] **Step 3: Verify Northstar local readiness**

Run:

```bash
node --run northstar -- --help
node --run northstar -- watch --help
npm run test:coverage
```

Expected:

- Both help commands exit `0`.
- `npm run test:coverage` exits `0`.
- The output must not require GitHub or SDK credentials for offline coverage.

- [ ] **Step 4: Verify GitHub auth without leaking the token**

Run:

```bash
gh auth status
gh auth token >/dev/null
```

Expected:

- Both commands exit `0`.
- No token value is printed.

- [ ] **Step 5: Commit the preflight documentation**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: start northstar vocab uat training manual"
```

Expected:

- Commit succeeds.
- `.superpowers/brainstorm/**` and `.codex/config.toml` remain uncommitted.

## Task 2: Create The Real Consumer Repository

**Files:**
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`
- Create remote: `paulpai0412/northstar-vocab-uat`
- Create local: `/home/timmypai/apps/northstar-vocab-uat`

- [ ] **Step 1: Use the Northstar skill operation for repo creation**

Invoke the Northstar skill with this exact operator request:

```text
Use the Northstar skill to create a new consumer repository for a real UAT.

Repository: paulpai0412/northstar-vocab-uat
Purpose: English vocabulary web app built by Northstar software-development automation.

Rules:
- This is not a smoke test.
- Use real GitHub.
- Do not write secrets anywhere.
- Record every operation and evidence URL into docs/training/northstar-vocab-uat-training-manual.md.
- Clone the repo to /home/timmypai/apps/northstar-vocab-uat.
```

- [ ] **Step 2: Verify the remote repository exists**

Run:

```bash
gh repo view paulpai0412/northstar-vocab-uat --json nameWithOwner,url,defaultBranchRef
```

Expected:

- `nameWithOwner` is `paulpai0412/northstar-vocab-uat`.
- `defaultBranchRef.name` is `main`.

- [ ] **Step 3: Verify the local clone**

Run:

```bash
git -C /home/timmypai/apps/northstar-vocab-uat remote get-url origin
git -C /home/timmypai/apps/northstar-vocab-uat branch --show-current
```

Expected:

- Origin points to `github.com:paulpai0412/northstar-vocab-uat.git` or `https://github.com/paulpai0412/northstar-vocab-uat.git`.
- Current branch is `main`.

- [ ] **Step 4: Update metrics and manual**

Set:

```json
"uat_consumer_repos_created": 1
```

Append an evidence row containing the repo URL.

- [ ] **Step 5: Commit the UAT repo evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat consumer repo creation"
```

Expected: commit succeeds.

## Task 3: Bootstrap Northstar In The Consumer Repo

**Files:**
- Create in consumer repo: `/home/timmypai/apps/northstar-vocab-uat/.northstar.yaml`
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Use the Northstar skill to bootstrap config**

Invoke the Northstar skill with this exact operator request:

```text
Use the Northstar skill in /home/timmypai/apps/northstar-vocab-uat.

Bootstrap this repo for real Northstar software-development automation.

Config requirements:
- workflow.domain: software_development
- workflow.id: issue_to_pr_release
- github.repo: paulpai0412/northstar-vocab-uat
- github.intake.label: northstar:ready
- runtime.host_adapter: codex
- runtime.auto_release: true
- runtime state under .northstar/runtime
- git worktrees under .northstar/runtime/worktrees
- GitHub credentials from GITHUB_TOKEN or gh fallback only
- no secrets written to .northstar.yaml

Show the generated .northstar.yaml draft, then write it after confirmation.
Record the operation and config path in the UAT training manual.
```

- [ ] **Step 2: Verify config is present and safe**

Run:

```bash
test -f /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml
rg "GITHUB_TOKEN|gh|northstar:ready|software_development|issue_to_pr_release|auto_release" /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml
rg "ghp_|github_pat_|sk-|OPENAI_API_KEY|token:" /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml
```

Expected:

- First `rg` finds the intended config signals.
- Second `rg` exits non-zero because no secrets are present.

- [ ] **Step 3: Verify Northstar can read the consumer config**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" node --run northstar -- inspect --config /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml
```

Expected:

- Command exits `0`.
- Output references the consumer repo config and does not expose token values.

- [ ] **Step 4: Commit consumer bootstrap**

Run:

```bash
git -C /home/timmypai/apps/northstar-vocab-uat add .northstar.yaml
git -C /home/timmypai/apps/northstar-vocab-uat commit -m "chore: configure northstar automation"
git -C /home/timmypai/apps/northstar-vocab-uat push origin main
```

Expected:

- Commit and push succeed.

## Task 4: Create GitHub Project Fields And Views

**Files:**
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Use the Northstar skill to create Project monitoring**

Invoke the Northstar skill with this exact operator request:

```text
Use the Northstar skill to create GitHub Project monitoring for paulpai0412/northstar-vocab-uat.

Project name: Northstar Vocabulary UAT

Create or reuse the Project only after confirmation.

Fields:
- Northstar Lifecycle
- Northstar Stage
- Northstar Role
- Northstar Host
- Northstar Issue Order
- Northstar Blocked By
- Northstar PR
- Northstar Branch
- Northstar Merge SHA
- Northstar Heartbeat
- Northstar Retry Count
- Northstar Last Error
- Northstar Completed At
- Northstar Attention

Views:
- PM Roadmap
- Engineer Work Queue
- Runtime Ops
- Release Queue
- Completed
- Dependencies

Record the Project URL, field count, and view count in docs/training/northstar-vocab-uat-training-manual.md and docs/training/northstar-vocab-uat-metrics.json.
```

- [ ] **Step 2: Verify Project metrics**

Use `gh project` or GraphQL through the Northstar skill to verify:

- Project exists or was reused.
- Field count is at least `12`.
- View count is at least `5`.

Set:

```json
"uat_project_created_or_reused": 1,
"uat_project_fields_configured": 14,
"uat_project_views_configured": 6
```

Use the actual field and view counts if they are higher.

- [ ] **Step 3: Commit Project evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat project setup"
```

Expected: commit succeeds.

## Task 5: Create Ordered GitHub Issues

**Files:**
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Use the Northstar skill to create the issue chain**

Invoke the Northstar skill with this exact operator request:

```text
Use the Northstar skill to create the ordered UAT issue chain in paulpai0412/northstar-vocab-uat.

Rules:
- The repository must be a clean UAT repo with no pre-existing issues.
- The expected GitHub issue numbers are #1 through #6. If GitHub would assign different numbers, stop and report the repo is not clean.
- Use real GitHub issues.
- Add label northstar:ready to executable issues.
- Add text dependency markers in each dependent issue.
- Add native GitHub linked issue dependencies when supported by GitHub permissions/API.
- Add every issue to the Northstar Vocabulary UAT Project.
- Set Northstar Issue Order field for each issue.
- Record issue URLs and dependency edges into docs/training/northstar-vocab-uat-training-manual.md.

Issue 1 title:
Project scaffold and local dev command
Body:
Create a Vite React TypeScript app for an English vocabulary learning tool. Add package scripts for dev, build, test, test:coverage, and test:e2e. Configure Vitest coverage thresholds at 90 for lines, branches, functions, and statements. Configure Playwright for desktop and mobile browser tests. Add a README with local commands.

Acceptance:
- npm install succeeds.
- npm run build succeeds.
- npm run test succeeds.
- npm run test:coverage enforces 90% lines/branches/functions/statements.
- npm run test:e2e launches a real browser test.
- No backend service is required.

Issue 2 title:
Vocabulary data model and seed deck
Body:
Depends-On: #1
Add a structured vocabulary deck with at least 20 English words. Each item must include word, part of speech, definition, example sentence, and pronunciation hint. Add unit tests for deck validation and lookup behavior.

Acceptance:
- vocab_seed_words >= 20.
- Unit tests cover valid deck loading and invalid deck detection.
- npm run test:coverage remains >=90% for lines/branches/functions/statements.

Issue 3 title:
Practice mode flashcards
Body:
Depends-On: #2
Build a practice mode that shows one vocabulary card at a time, hides and reveals definition/example content, and lets the user mark a word as known or needs review. Add tests for card state transitions.

Acceptance:
- A user can study at least one word.
- practice_words_studied >= 1 in browser verification.
- Unit tests cover reveal, known, and needs-review actions.
- npm run test:coverage remains >=90% for lines/branches/functions/statements.

Issue 4 title:
Quiz mode with answer feedback
Body:
Depends-On: #2
Build quiz mode with multiple-choice questions generated from the seed deck. Show answer feedback and move to the next question. Add tests for quiz generation and scoring.

Acceptance:
- A user can answer at least one quiz question.
- quiz_questions_answered >= 1 in browser verification.
- Unit tests cover option generation, correct answer selection, and incorrect answer feedback.
- npm run test:coverage remains >=90% for lines/branches/functions/statements.

Issue 5 title:
Progress tracking and review queue
Body:
Depends-On: #3
Depends-On: #4
Persist attempted, correct, mastered, and needs-review state in browser local storage. Add a review queue that prioritizes weak or unmastered words. Add tests for persistence and queue ordering.

Acceptance:
- progress_updates_recorded >= 1 in browser verification.
- review_queue_items_visible >= 1 in browser verification.
- Unit tests cover saving, loading, reset, and review queue prioritization.
- npm run test:coverage remains >=90% for lines/branches/functions/statements.

Issue 6 title:
Responsive UI polish and final verification
Body:
Depends-On: #5
Polish the UI for desktop and mobile. Add accessible labels for key controls, clear empty/completion states, and final README verification instructions. Ensure Playwright verifies the full study flow on desktop and mobile.

Acceptance:
- desktop_viewport_verified = 1.
- mobile_viewport_verified = 1.
- npm run build succeeds.
- npm run test succeeds.
- npm run test:coverage reports >=90% lines/branches/functions/statements.
- npm run test:e2e passes in a real browser.
```

- [ ] **Step 2: Verify issue numbers and metrics**

Run:

```bash
gh issue list --repo paulpai0412/northstar-vocab-uat --state open --limit 20 --json number,title,labels,url
```

Expected:

- Issues #1 through #6 exist with the titles listed above.
- All 6 issues have `northstar:ready`.
- Issue #2 includes `Depends-On: #1`.
- Issue #3 includes `Depends-On: #2`.
- Issue #4 includes `Depends-On: #2`.
- Issue #5 includes `Depends-On: #3` and `Depends-On: #4`.
- Issue #6 includes `Depends-On: #5`.
- At least 5 dependency edges are represented.

Set:

```json
"uat_issues_created": 6,
"uat_dependency_edges_created": 5,
"uat_ready_labeled_issues": 6
```

- [ ] **Step 3: Commit issue evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat issue plan"
```

Expected: commit succeeds.

## Task 6: Execute Real Northstar Development Flow

**Files:**
- Modify in consumer repo through Northstar PRs only.
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Start watch through the Northstar skill**

Invoke the Northstar skill with this exact operator request:

```text
Use the Northstar skill in /home/timmypai/apps/northstar-vocab-uat.

Start real Northstar watch for the configured GitHub repo.

Rules:
- This is a full UAT execution, not a smoke test.
- Use production dependencies only.
- Use real GitHub issue intake.
- Use real local issue worktrees.
- Use real Codex SDK worker path.
- Use real git add, commit, push.
- Use real PR create or reuse.
- Use real verifier.
- Use real merge and close issue.
- Respect issue dependencies. Do not dispatch blocked issues.
- Record lifecycle evidence, issue URLs, PR URLs, merge SHAs, and recovery actions in the UAT training manual.
```

- [ ] **Step 2: Monitor issue ordering**

During execution, inspect active work after each completed issue:

```bash
GITHUB_TOKEN="$(gh auth token)" node --run northstar -- inspect --config /home/timmypai/apps/northstar-vocab-uat/.northstar.yaml
gh issue list --repo paulpai0412/northstar-vocab-uat --state all --limit 20 --json number,title,state,labels,url
gh pr list --repo paulpai0412/northstar-vocab-uat --state all --limit 20 --json number,title,state,mergedAt,headRefName,url
```

Expected:

- Issue 1 completes before Issue 2 starts.
- Issue 2 completes before Issues 3 or 4 start.
- Issues 3 and 4 complete before Issue 5 starts.
- Issue 5 completes before Issue 6 starts.
- `uat_dependency_order_violations` remains `0`.

- [ ] **Step 3: Verify real worktree path evidence**

Run:

```bash
find /home/timmypai/apps/northstar-vocab-uat/.northstar/runtime/worktrees -maxdepth 2 -type d | sort
```

Expected:

- At least one `issue-*` worktree path exists.
- Worktrees are under `/home/timmypai/apps/northstar-vocab-uat/.northstar/runtime/worktrees`.

- [ ] **Step 4: Verify PR and merge evidence**

Run:

```bash
gh pr list --repo paulpai0412/northstar-vocab-uat --state merged --limit 20 --json number,title,url,mergeCommit,mergedAt
```

Expected:

- At least 6 merged PRs exist for the UAT issue chain.
- Each merged PR has a merge commit SHA.

Set:

```json
"uat_prs_created_or_reused": 6,
"uat_prs_merged": 6,
"uat_northstar_completed_issues": 6,
"uat_github_issues_closed": 6,
"uat_duplicate_prs_created": 0
```

Use actual counts if higher.

- [ ] **Step 5: Verify issues are closed**

Run:

```bash
gh issue list --repo paulpai0412/northstar-vocab-uat --state closed --limit 20 --json number,title,url
```

Expected:

- All 6 UAT issues are closed.

- [ ] **Step 6: Commit runtime execution evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat northstar execution"
```

Expected: commit succeeds.

## Task 7: Verify Consumer App Coverage And Build

**Files:**
- Read in consumer repo: `package.json`
- Read in consumer repo: `coverage/coverage-summary.json`
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Pull latest merged app**

Run:

```bash
git -C /home/timmypai/apps/northstar-vocab-uat checkout main
git -C /home/timmypai/apps/northstar-vocab-uat pull --ff-only origin main
```

Expected:

- Local consumer repo is at latest `main`.

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm --prefix /home/timmypai/apps/northstar-vocab-uat install
```

Expected:

- Install exits `0`.

- [ ] **Step 3: Run build and tests**

Run:

```bash
npm --prefix /home/timmypai/apps/northstar-vocab-uat run build
npm --prefix /home/timmypai/apps/northstar-vocab-uat run test
npm --prefix /home/timmypai/apps/northstar-vocab-uat run test:coverage
```

Expected:

- All commands exit `0`.
- Coverage thresholds are enforced at `90` for lines, branches, functions, and statements.

- [ ] **Step 4: Verify coverage JSON values**

Read `/home/timmypai/apps/northstar-vocab-uat/coverage/coverage-summary.json`.

Expected:

```json
{
  "total": {
    "lines": { "pct": 90 },
    "branches": { "pct": 90 },
    "functions": { "pct": 90 },
    "statements": { "pct": 90 }
  }
}
```

The actual `pct` values may be higher. Record the actual percentages into:

```json
"consumer_coverage_lines": 90,
"consumer_coverage_branches": 90,
"consumer_coverage_functions": 90,
"consumer_coverage_statements": 90
```

- [ ] **Step 5: Commit coverage evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat coverage evidence"
```

Expected: commit succeeds.

## Task 8: Execute Real Browser UAT

**Files:**
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Run automated browser E2E**

Run:

```bash
npm --prefix /home/timmypai/apps/northstar-vocab-uat run test:e2e
```

Expected:

- Playwright launches a real browser.
- Desktop and mobile projects both pass.
- The browser journey studies a card, answers a quiz question, updates progress, and shows review queue state.

- [ ] **Step 2: Start the real app for manual browser verification**

Run:

```bash
npm --prefix /home/timmypai/apps/northstar-vocab-uat run dev -- --host 127.0.0.1
```

Expected:

- Dev server starts and prints a localhost URL.
- Keep the server running until manual browser verification is complete.

- [ ] **Step 3: Verify desktop browser journey**

Use the Codex Browser or Playwright against the localhost URL.

Required desktop viewport:

```text
1280x800
```

Actions:

1. Open the app.
2. Confirm at least 20 vocabulary words are available.
3. Study one card.
4. Reveal the definition or example.
5. Mark the word as known or needs review.
6. Open quiz mode.
7. Answer one question.
8. Confirm progress changed.
9. Open review queue.
10. Confirm at least one review item is visible.

Expected metrics:

```json
"vocab_seed_words": 20,
"practice_words_studied": 1,
"quiz_questions_answered": 1,
"progress_updates_recorded": 1,
"review_queue_items_visible": 1,
"desktop_viewport_verified": 1
```

- [ ] **Step 4: Verify mobile browser journey**

Use the Codex Browser or Playwright against the same localhost URL.

Required mobile viewport:

```text
390x844
```

Actions:

1. Open the app.
2. Confirm navigation and key controls fit without overlap.
3. Study one card.
4. Answer one quiz question.
5. Confirm review/progress state remains accessible.

Expected metric:

```json
"mobile_viewport_verified": 1
```

- [ ] **Step 5: Record browser pass**

Set:

```json
"uat_browser_study_flow_passed": 1
```

Append browser evidence to the training manual with:

- Local URL.
- Desktop viewport result.
- Mobile viewport result.
- Coverage summary.
- Screenshot paths if generated.

- [ ] **Step 6: Commit browser UAT evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat browser verification"
```

Expected: commit succeeds.

## Task 9: Verify GitHub Project Observability

**Files:**
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Inspect issue comments and status markers**

Use the Northstar skill to inspect GitHub observability:

```text
Use the Northstar skill to inspect progress observability for paulpai0412/northstar-vocab-uat.

Verify:
- Each UAT issue has Northstar lifecycle labels or final completed state.
- Each UAT issue has progress comments.
- Each UAT issue has an updated northstar-status marker when supported.
- Each merged PR links back to its source issue.
- Each verifier PR comment exists when the workflow produced verifier evidence.
- The Project fields show lifecycle and PR evidence.

Record counts and URLs in docs/training/northstar-vocab-uat-training-manual.md and update docs/training/northstar-vocab-uat-metrics.json.
```

- [ ] **Step 2: Verify quantitative observability metrics**

Expected:

```json
"uat_project_lifecycle_updates": 6,
"uat_progress_comments_created": 6
```

Use actual counts if higher.

- [ ] **Step 3: Verify no secret leaks**

Run:

```bash
rg "ghp_|github_pat_|sk-|OPENAI_API_KEY|GITHUB_TOKEN" docs/training /home/timmypai/apps/northstar-vocab-uat || true
```

Expected:

- No secret values are found.
- Literal environment variable names may appear only as documentation references, not with values.

Set:

```json
"uat_secret_leaks": 0
```

- [ ] **Step 4: Commit observability evidence**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: record vocab uat observability evidence"
```

Expected: commit succeeds.

## Task 10: Final Training Manual Completion

**Files:**
- Modify: `docs/training/northstar-vocab-uat-training-manual.md`
- Modify: `docs/training/northstar-vocab-uat-metrics.json`

- [ ] **Step 1: Complete manual sections**

Ensure the manual contains these sections:

```markdown
## 1. Overview And Goals
## 2. Evidence Log
## 3. Prerequisites And Credentials
## 4. Consumer Repo Creation
## 5. Northstar Skill Bootstrap
## 6. Project Fields And Views
## 7. Issue Design And Dependency Ordering
## 8. Starting Watch And Monitoring Execution
## 9. GitHub Issue, PR, And Project Observability
## 10. Recovery And Retry Procedures
## 11. Browser Acceptance Testing
## 12. Coverage Evidence
## 13. Final Metrics
## 14. Troubleshooting
## 15. Reuse Checklist For Another Consumer Repo
```

- [ ] **Step 2: Update manual section metric**

Set:

```json
"uat_training_manual_sections_completed": 15
```

- [ ] **Step 3: Verify all required metrics pass**

Open `docs/training/northstar-vocab-uat-metrics.json` and verify:

```json
{
  "uat_consumer_repos_created": 1,
  "uat_project_created_or_reused": 1,
  "uat_project_fields_configured": 12,
  "uat_project_views_configured": 5,
  "uat_issues_created": 6,
  "uat_dependency_edges_created": 5,
  "uat_dependency_order_violations": 0,
  "uat_ready_labeled_issues": 6,
  "uat_northstar_completed_issues": 6,
  "uat_prs_created_or_reused": 6,
  "uat_prs_merged": 6,
  "uat_github_issues_closed": 6,
  "uat_project_lifecycle_updates": 6,
  "uat_progress_comments_created": 6,
  "uat_duplicate_prs_created": 0,
  "uat_secret_leaks": 0,
  "uat_training_manual_sections_completed": 15,
  "uat_browser_study_flow_passed": 1,
  "vocab_seed_words": 20,
  "practice_words_studied": 1,
  "quiz_questions_answered": 1,
  "progress_updates_recorded": 1,
  "review_queue_items_visible": 1,
  "desktop_viewport_verified": 1,
  "mobile_viewport_verified": 1,
  "consumer_coverage_lines": 90,
  "consumer_coverage_branches": 90,
  "consumer_coverage_functions": 90,
  "consumer_coverage_statements": 90
}
```

Actual count and coverage values may exceed the listed minimums. They must not be lower.

- [ ] **Step 4: Commit the completed manual**

Run:

```bash
git add docs/training/northstar-vocab-uat-training-manual.md docs/training/northstar-vocab-uat-metrics.json
git commit -m "docs: complete northstar vocab uat training manual"
```

Expected: commit succeeds.

## Task 11: Final Verification Gate

**Files:**
- Read: Northstar repository.
- Read: consumer repository.
- Read: GitHub repo/project/issues/PRs.

- [ ] **Step 1: Verify Northstar repository gates**

Run from `/home/timmypai/apps/northstar`:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
node --run northstar -- --help
node --run northstar -- watch --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
```

Expected:

- All test/help commands exit `0`.
- Forbidden dependency scans return no production violations.
- Any `process.env` references are existing allowed boundary references.
- State machine purity scan returns no matches.

- [ ] **Step 2: Verify consumer repository gates**

Run from `/home/timmypai/apps/northstar-vocab-uat`:

```bash
npm install
npm run build
npm run test
npm run test:coverage
npm run test:e2e
git status --short
```

Expected:

- Build, tests, coverage, and browser E2E exit `0`.
- Coverage is at least 90 for lines, branches, functions, and statements.
- `git status --short` is clean after all Northstar PRs are merged and local `main` is pulled.

- [ ] **Step 3: Verify real GitHub completion**

Run:

```bash
gh issue list --repo paulpai0412/northstar-vocab-uat --state closed --limit 20 --json number,title,url
gh pr list --repo paulpai0412/northstar-vocab-uat --state merged --limit 20 --json number,title,url,mergeCommit
```

Expected:

- At least 6 closed UAT issues.
- At least 6 merged UAT PRs.
- Each merged PR has a merge commit SHA.

- [ ] **Step 4: Verify no fake or smoke evidence is used**

Run:

```bash
rg "FakeDomainDriver|FakeGitHub|fake gateway|smoke-only|simulated merge|simulated PR|mock browser" docs/training /home/timmypai/apps/northstar-vocab-uat || true
```

Expected:

- No evidence row claims fake, simulated, or smoke-only execution as a pass.

- [ ] **Step 5: Verify final Northstar repository status**

Run:

```bash
git status --short --untracked-files=all
```

Expected:

- Only intentional untracked local files may remain, such as `.codex/config.toml` or `.superpowers/brainstorm/**`.
- Training manual and metrics are committed.

## Final Report Requirements

The executor must report:

- Consumer repo URL.
- GitHub Project URL.
- All issue numbers and URLs.
- All PR numbers and URLs.
- Merge SHAs.
- Dependency ordering result.
- Consumer app coverage percentages for lines, branches, functions, and statements.
- Browser verification results for desktop and mobile.
- Final UAT metrics table.
- Northstar fresh verification output summary.
- Consumer repo fresh verification output summary.
- Training manual path.
- Any recovery actions used.
- Any unresolved blockers.

## Execution Handoff Prompt

Use this prompt to start the actual UAT execution:

```text
/goal
使用 Superpowers executing-plans 執行 docs/superpowers/plans/2026-05-31-northstar-vocab-uat-training-execution-plan.md。

完成 Northstar Vocabulary UAT Training Execution：
- 建立真實 consumer repo paulpai0412/northstar-vocab-uat。
- 一切 consumer repo 操作皆使用 Northstar skill 發起與記錄。
- 建立真實 GitHub Project fields/views。
- 建立至少 6 個真實 GitHub issues 與至少 5 條依賴關係。
- 使用 northstar:ready label 讓 Northstar 接手。
- 使用真實 Northstar production CLI/watch、真實 GitHub、真實 local worktree、真實 Codex SDK worker、真實 git add/commit/push、真實 PR、真實 merge、真實 issue close。
- 不可 fake、不可 smoke、不可用 simulated PR/merge/browser。
- 最終 app 必須可用真實 browser 驗收。
- consumer app test coverage lines/branches/functions/statements 必須 >=90%。
- Northstar npm run test:coverage 必須通過。
- 產出 docs/training/northstar-vocab-uat-training-manual.md 與 docs/training/northstar-vocab-uat-metrics.json。

完成前執行 plan 內 Final Verification Gate。

最後回報：
- consumer repo URL
- GitHub Project URL
- issue URLs
- PR URLs
- merge SHAs
- dependency ordering result
- coverage percentages
- desktop/mobile browser UAT result
- final UAT metrics
- fresh verification output summary
- training manual path
- recovery actions
- unresolved blockers
```
