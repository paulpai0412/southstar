# Southstar Product UI Review

Date: 2026-06-30
Scope: Chat, Workflow, Operator control tower, floating task sidecar
Evidence folder: `docs/superpowers/audits/2026-06-30-product-ui-review/`

## Captured Steps

1. Chat entry: `01-chat-entry.png`
   - Health: weak empty-state product guidance.
   - Notes: Entry relies on selecting project first, but the main canvas does not explain what Chat is best for or what a successful first action looks like.

2. Workflow entry: `02-workflow-entry.png`
   - Health: library is visible, but creation path is under-explained.
   - Notes: The left library has useful assets, yet the center remains a generic getting-started page. Selecting a workflow template does not yet feel like a productized launch flow.

3. Operator overview: `03-operator-overview.png`
   - Health: good foundation, not yet product-grade.
   - Notes: Runtime State Board and Operator Focus are visible, but the page does not clearly answer "what is happening, what is blocked, what should I do next, and how risky is it?"

4. Operator task sidecar history: `04-operator-sidecar-history.png`
   - Health: useful for engineers, heavy for operators.
   - Notes: History exposes raw event payloads. It needs an operator-readable incident summary, timeline, root cause, impact, and recommended action layer above raw JSON.

5. Operator sidecar tab interaction: `05-operator-sidecar-dag.png`
   - Health: interaction defect.
   - Notes: Attempting to click the visible DAG sidecar tab was intercepted by the scrollable history content. The screenshot remained on History, and Playwright reported sidecar content intercepting pointer events.

6. Mobile entry: `08-mobile-entry-blocked-tabs.png`
   - Health: not product-ready on narrow screens.
   - Notes: The open sidebar covers the top mode tabs and intercepts Operator tab clicks. Mobile/tablet layout needs a deliberate navigation pattern.

## Product-Level Gaps

1. Operator lacks an answer-first incident model.
   - Current UI shows event streams and task status, but not an incident card with root cause, affected workflow/task, time since first seen, owner, confidence, impact, and next recommended action.

2. State board groups lifecycle state but not operational priority.
   - A product-grade control tower should rank by urgency, age, blast radius, and stuckness. Current buckets show counts and cards but still make the user inspect individual rows to understand severity.

3. Attention list is repetitive and low signal.
   - Many rows share the same "blocked stale_callback runtime e..." label. The list needs grouping, deduplication, run/task context, and a visible reason/next action.

4. Sidecar is a debug console, not yet a task workspace.
   - History, SSE, Actions, Artifacts, and DAG exist, but they compete as raw tabs. The sidecar needs a top-level task summary and a progressive disclosure model.

5. Workflow launch is not productized.
   - Workflow library exists, but the main canvas does not guide template selection, required inputs, validation, dry-run, execution, and operator handoff as one cohesive journey.

6. Chat, Workflow, and Operator modes feel adjacent rather than connected.
   - The product needs clear handoffs: Chat creates/introspects, Workflow plans/launches, Operator monitors/recovers. Current UI exposes the tabs but does not make the relationship obvious.

7. Project scope is necessary but under-communicated.
   - Project Scope exists, yet the UI does not show why a repo is required, what will be filtered, or whether the current active workflows belong to that scope.

8. Recovery actions are too close to raw commands.
   - A product-grade recovery flow needs a reason prompt, expected consequence, affected artifacts/sessions, rollback/retry scope, and post-action confirmation.

9. Responsive behavior is not ready.
   - Narrow viewport navigation and sidebar overlay make core mode switching unreliable.

10. Accessibility needs explicit pass.
    - Screenshot review suggests small text, dense click targets, icon-only controls, low contrast muted text, and limited focus-state confidence. Keyboard and screen-reader behavior still need testing.

## Recommended Product Roadmap

### P0 Product Readiness

- Fix sidecar tab click interception.
- Fix mobile/narrow navigation so mode tabs remain reachable.
- Add an Operator incident summary card above raw task details.
- Group duplicate attention items by run/task/root cause.

### P1 Control Tower Clarity

- Add "Now / At Risk / Needs Action / Recently Resolved" lanes or equivalent priority model.
- Add operator-readable stuck duration, last event, next retry/recovery window, and owner/lease state.
- Add one-click "open evidence" from an incident summary into History/SSE/Artifacts.

### P1 Workflow Productization

- Turn workflow template selection into a launch wizard: choose template, confirm repo, fill inputs, validate DAG, launch, hand off to Operator.
- Show selected workflow template details in the center instead of a generic empty canvas.
- Add post-launch confirmation with direct Operator link.

### P2 Cross-Mode Cohesion

- Add a shared top-level product status strip: selected project, active runs, blocked count, last refresh, runtime health.
- Add consistent empty states for Chat, Workflow, Operator that explain the mode's job and primary next step.
- Preserve the same sidecar behavior and tab semantics across file, workflow node, and operator task viewers.

### P2 Accessibility And Polish

- Increase tap/click target consistency.
- Add clearer focus rings and active states.
- Audit contrast for muted text and warning labels.
- Add keyboard path tests for mode switching, sidebar selection, sidecar tabs, and command actions.

