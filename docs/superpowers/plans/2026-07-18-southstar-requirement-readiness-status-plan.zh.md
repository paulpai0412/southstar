# Southstar Requirement Readiness Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Goal Requirements list 逐列顯示 warning／完成狀態，讓使用者能立即知道哪個 requirement 尚未通過 visual contract 或其他 host readiness 檢查。

**Architecture:** 只使用現有 `GoalRequirementsContent.validationIssues`、每個 requirement 的 `openQuestions`／`status` 與既有 row selection。以 requirement 在 draft 中的原始 index 對應後端 validation path，避免新增 API、資料表或瀏覽器自行放寬 `confirmable` gate。

**Tech Stack:** Next.js、React、TypeScript、Playwright browser harness、Node test runner。

## Global Constraints

- Reuse the repository's current architecture and public API seams.
- The browser must never infer or override host-owned `confirmable` readiness.
- Do not add fixture, fake provider, fallback, parallel API, or new persistence model.
- Preserve accessible text/labels; status must not depend on color alone.
- Verify focused UI tests, web build, and `git diff --check` before completion.

---

### Task 1: Add the failing per-requirement readiness test

**Files:**
- Modify: `/home/timmypai/apps/southstar/tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**
- Consumes: existing `GoalRequirementListBlock` browser harness and `requirementDraftView()` helper.
- Produces: an executable regression test expecting `goal-requirement-status-<requirementId>` and `goal-requirements-readiness-summary`.

- [x] **Step 1: Write the failing browser test**

Add a second requirement with one UI contract and an unconfirmed host issue, then assert one complete row and one warning row:

```tsx
test("Requirement list exposes per-requirement readiness status", async () => {
  const draft = requirementDraftView();
  draft.requirements.push({
    ...draft.requirements[0],
    id: "req-contract",
    title: "Contract review flow",
    interactionContractRefs: ["ui-contract"],
  });
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{
      type: "goalRequirements",
      draftId: "draft-goal-1",
      status: "requirements_review",
      goalRequirementDraftHash: "hash-1",
      draft: ${JSON.stringify(draft)},
      confirmable: false,
      validationIssues: [{
        path: "requirements.1.interactionContractRefs.0",
        code: "unconfirmed_ui_interaction_contract",
        message: "UI interaction contract is not confirmed: ui-contract",
      }],
    }} />);
  `, async (page) => {
    assert.match(await page.getByTestId("goal-requirement-status-req-review").innerText(), /Complete|Ready/i);
    assert.match(await page.getByTestId("goal-requirement-status-req-contract").innerText(), /Warning|Needs attention/i);
    assert.match(await page.getByTestId("goal-requirements-readiness-summary").innerText(), /1.*2|1.*attention/i);
  });
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm exec -- tsx tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected: the new test fails because the status test ids do not exist yet.

### Task 2: Implement the smallest readiness projection in the requirement list

**Files:**
- Modify: `/home/timmypai/apps/southstar/web/components/GoalRequirementListBlock.tsx`

**Interfaces:**
- Consumes: `GoalRequirementsContent.validationIssues`, `GoalRequirementView.status`, and existing row selection.
- Produces: `requirementReadiness(requirement, requirementIndex, block)` returning `{ tone, icon, label, detail }` for rendering and accessibility.

- [x] **Step 1: Add the pure readiness helper**

Add this local type and function near the existing parsing helpers:

```ts
type RequirementReadiness = {
  tone: "warning" | "complete" | "neutral";
  icon: "⚠" | "✓" | "•";
  label: string;
  detail: string;
};

function requirementReadiness(
  requirement: GoalRequirementDraftView["requirements"][number],
  requirementIndex: number,
  block: GoalRequirementsContent,
): RequirementReadiness {
  const prefix = `requirements.${requirementIndex}`;
  const issues = (block.validationIssues ?? []).filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
  if (issues.length > 0 || requirement.openQuestions.length > 0) {
    return { tone: "warning", icon: "⚠", label: "Needs attention", detail: issues[0]?.message ?? "Answer the open question before confirmation." };
  }
  if (requirement.status === "ready") {
    return { tone: "complete", icon: "✓", label: "Complete", detail: "Requirement is ready for confirmation." };
  }
  return { tone: "neutral", icon: "•", label: "Pending host review", detail: "Waiting for host readiness data." };
}
```

- [x] **Step 2: Render the status and aggregate summary**

Iterate with the original draft index so paths such as `requirements.1.interactionContractRefs.0` remain correct. Add `goal-requirement-status-${requirement.id}` with visible icon/text and `aria-label`, and add a header summary using the count of `complete` rows.

- [x] **Step 3: Run the focused test and verify it passes**

Run:

```bash
npm exec -- tsx tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected: all existing UI tests plus the new per-requirement readiness test pass.

### Task 3: Verify the complete change without widening scope

**Files:**
- Read: `/home/timmypai/apps/southstar/docs/superpowers/specs/2026-07-18-southstar-requirement-readiness-status-design.zh.md`
- Verify: `/home/timmypai/apps/southstar/web/components/GoalRequirementListBlock.tsx`
- Verify: `/home/timmypai/apps/southstar/tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**
- Consumes: Task 2 UI projection and regression test.
- Produces: build and diff evidence suitable for browser testing.

- [x] **Step 1: Run the focused UI test once more after formatting/type changes**

```bash
npm exec -- tsx tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected: PASS with the existing suite count increased by the new regression test.

- [x] **Step 2: Build the active web app**

```bash
npm --prefix web run build
```

Expected: Next.js compile, TypeScript, and static generation complete with exit code 0.

- [x] **Step 3: Check the diff**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the intended requirement-list UI and test files remain unstaged in addition to the already-existing runtime changes.
