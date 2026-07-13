# Southstar Semantic Session Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 讓 Library、Workflow 與 Operator 左側清單以持久化、可修改、可重生的 LLM semantic title/tooltip 說明 session/run 的目的與重用價值，同時保持現有 Pi session 與 workflow run lifecycle truth。

**Architecture:** 建立一個 SessionPresentation 深 module與strict generator；Pi sessions以append-only custom metadata adapter儲存，Operator runs以既有runtime_resources adapter儲存。Sidebar read models合併穩定的LLM semantic內容與host-owned status/time/count；生成是背景enhancement，不在list render path同步呼叫LLM。

**Tech Stack:** Node.js >=22.22.2、TypeScript ESM、tsx、Node node:test、Postgres southstar schema、Next.js 16、React 19、Pi SessionManager、現有 RuntimeServerContext LLM provider。

## Global Constraints

- Preserve existing LibrarySidebar, WorkflowSidebar, OperatorSidebar, SessionSidebar and AppShell layout.
- Do not replace Pi .jsonl session files or workflow_runs. Do not add a database table.
- Library/Workflow and Operator use separate persistence adapters behind one SessionPresentation interface.
- LLM receives a bounded secret-safe semantic packet, never full transcripts, readiness diagnostics, raw logs, stack traces, credentials, vault data or full absolute paths.
- LLM proposes title, purposeSummary, reuseHint and keywords only. Host code owns status, time, counts, project labels, revisions, hashes and locks.
- Do not call LLM from sidebar render, GET /api/sessions, operator overview reads or refresh handlers.
- Manual edits lock only the edited fields. Automatic generation cannot overwrite locked fields.
- Existing name || firstMessage || run.goalPrompt remains a non-blocking fallback.
- Do not create production fixtures, mock title generators, canned surface-specific title templates or domain keyword classifiers.
- Use inline generator doubles in focused tests. Production generator remains LLM-backed and fail-soft.

---

## File Structure

### New runtime files

- src/v2/session-presentation/types.ts — canonical presentation/proposal/source packet types, validation, merging, hashing and revision helpers.
- src/v2/session-presentation/generator.ts — strict LLM prompt/parser with one repair attempt.
- src/v2/session-presentation/postgres-store.ts — Operator run presentation resources and pending generation requests.
- src/v2/session-presentation/generation-loop.ts — durable pending request processor for Operator runs.
- src/v2/server/session-presentation-routes.ts — proposal generation and Operator edit/regenerate routes.
- tests/v2/session-presentation.test.ts — schema, merge, manual lock and generation tests.
- tests/v2/postgres-session-presentation.test.ts — Operator persistence, idempotency and generation loop tests.

### New web files

- web/lib/session-presentation.ts — Pi custom entry adapter, latest revision reader and tooltip view-model composition.
- web/app/api/sessions/[id]/presentation/route.ts — read/edit Pi presentation.
- web/app/api/sessions/[id]/presentation/generate/route.ts — bounded packet builder, runtime proposal call and append-only persist.
- web/components/SessionPresentationTooltip.tsx — accessible hover/focus tooltip.
- web/components/SessionPresentationEditor.tsx — title/purpose/reuse/keyword edit, locks, regenerate and restore.
- tests/web/southstar-session-presentation-route.test.ts — Pi adapter/API tests.
- tests/web/southstar-session-presentation-ui.test.tsx — three-sidebar rendering and edit tests.

### Existing files to deepen

- src/v2/server/runtime-context.ts
- src/v2/server/http-server.ts
- src/v2/server/routes.ts
- src/v2/server/runtime-loop-registry.ts
- src/v2/server/runtime-loops.ts
- src/v2/ui-api/postgres-run-api.ts
- src/v2/read-models/operator-overview.ts
- src/v2/read-models/operator-attention.ts
- src/v2/cli.ts
- web/lib/types.ts
- web/lib/session-reader.ts
- web/app/api/sessions/route.ts
- web/app/api/sessions/[id]/route.ts
- web/hooks/useAgentSession.ts
- web/components/library/LibraryWorkspace.tsx
- web/components/library/LibrarySidebar.tsx
- web/components/WorkflowSidebar.tsx
- web/components/operator/OperatorSidebar.tsx
- web/lib/operator/types.ts

---

### Task 1: Canonical SessionPresentation and Strict LLM Generator

**Files:**
- Create: src/v2/session-presentation/types.ts
- Create: src/v2/session-presentation/generator.ts
- Create: tests/v2/session-presentation.test.ts
- Modify: src/v2/server/runtime-context.ts
- Modify: tests/v2/index.test.ts

**Interfaces:**
- Consumes: LlmTextClient.
- Produces: SessionPresentationV1, SessionPresentationProposalV1, SessionPresentationSourcePacketV1, validateSessionPresentationProposal(), mergeSessionPresentationProposal(), SessionPresentationGenerator, createLlmSessionPresentationGenerator().

- [ ] **Step 1: Add failing schema, lock and generator tests**

~~~ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeSessionPresentationProposal,
  validateSessionPresentationProposal,
} from '../../src/v2/session-presentation/types.ts';
import { createLlmSessionPresentationGenerator } from '../../src/v2/session-presentation/generator.ts';

test('manual fields survive automatic presentation regeneration', () => {
  const current = presentation({
    title: 'Manual workflow title',
    purposeSummary: 'Old generated summary',
    source: 'manual',
    manualLocks: ['title'],
  });
  const next = mergeSessionPresentationProposal(current, {
    title: 'Generated replacement',
    purposeSummary: 'Confirmed offline article goal',
    reuseHint: 'Resume requirement review',
    keywords: ['offline', 'article'],
  }, { sourceHash: 'source-2', generatedAt: '2026-07-13T00:00:00.000Z' });
  assert.equal(next.title, 'Manual workflow title');
  assert.equal(next.purposeSummary, 'Confirmed offline article goal');
  assert.equal(next.revision, current.revision + 1);
});

test('proposal rejects host-owned status time count and path fields', () => {
  assert.deepEqual(
    validateSessionPresentationProposal({
      title: 'Workflow title',
      purposeSummary: 'Purpose',
      reuseHint: 'Reuse',
      keywords: ['goal'],
      status: 'running',
    }),
    [{ code: 'unknown_key', path: 'status', message: 'status is host-owned' }],
  );
});

test('LLM generator receives a bounded source packet and returns exact semantic fields', async () => {
  const prompts: string[] = [];
  const generator = createLlmSessionPresentationGenerator({
    model: 'inline-presentation-test',
    client: { async generateText({ prompt }) {
      prompts.push(prompt);
      return JSON.stringify({
        title: 'Offline article workflow',
        purposeSummary: 'Create and verify a self-contained article.',
        reuseHint: 'Resume Goal Design or fork for another article.',
        keywords: ['offline', 'article', 'goal-design'],
      });
    } },
  });
  const proposal = await generator.generate(sourcePacket());
  assert.equal(proposal.title, 'Offline article workflow');
  assert.doesNotMatch(prompts[0]!, /Library ready|stack trace|\\/home\\/user/);
});
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: npx tsx tests/v2/session-presentation.test.ts

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Add exact types and validators**

~~~ts
export type SessionPresentationField =
  | 'title'
  | 'purposeSummary'
  | 'reuseHint'
  | 'keywords';

export type SessionPresentationV1 = {
  schemaVersion: 'southstar.session_presentation.v1';
  surface: 'library' | 'workflow' | 'operator';
  subjectId: string;
  revision: number;
  title: string;
  purposeSummary: string;
  reuseHint: string;
  keywords: string[];
  source: 'llm' | 'manual' | 'fallback';
  sourceHash: string;
  generatedAt?: string;
  manualLocks: SessionPresentationField[];
  parentSubjectId?: string;
};

export type SessionPresentationProposalV1 = {
  title: string;
  purposeSummary: string;
  reuseHint: string;
  keywords: string[];
};

export type SessionPresentationSourcePacketV1 = {
  schemaVersion: 'southstar.session_presentation_source.v1';
  surface: SessionPresentationV1['surface'];
  subjectId: string;
  firstMeaningfulIntent: string;
  confirmedGoalSummary?: string;
  requirementSummaries?: string[];
  libraryObjectRefs?: string[];
  outcomeSummary?: string;
  parentPresentation?: Pick<SessionPresentationV1, 'title' | 'purposeSummary'>;
};
~~~

Validate exact proposal keys; title 4–72 Unicode characters, purposeSummary 12–240, reuseHint 8–180, at most 8 unique keywords of 2–32 characters. Reject controls, blank-only values and fields resembling credentials. mergeSessionPresentationProposal() preserves locks, increments revision and replaces only unlocked fields.

- [ ] **Step 4: Implement the strict generator**

~~~ts
export type SessionPresentationGenerator = {
  generate(source: SessionPresentationSourcePacketV1): Promise<SessionPresentationProposalV1>;
};
~~~

Render only the source packet fields, require JSON-only exact output, parse once plus one repair response, and call validateSessionPresentationProposal(). Add optional sessionPresentationGenerator to RuntimeServerContext; CLI/server wiring supplies an LLM-backed generator from the same configured Pi text client, not a canned fallback.

- [ ] **Step 5: Run focused tests**

Run: npx tsx tests/v2/session-presentation.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/session-presentation/types.ts src/v2/session-presentation/generator.ts src/v2/server/runtime-context.ts tests/v2/session-presentation.test.ts tests/v2/index.test.ts
git commit -m "feat: add semantic session presentation contract"
~~~

---

### Task 2: Operator Postgres Adapter and Durable Generation Loop

**Files:**
- Create: src/v2/session-presentation/postgres-store.ts
- Create: src/v2/session-presentation/generation-loop.ts
- Create: tests/v2/postgres-session-presentation.test.ts
- Modify: src/v2/server/runtime-loop-registry.ts
- Modify: src/v2/server/runtime-loops.ts
- Modify: src/v2/ui-api/postgres-run-api.ts
- Modify: tests/v2/index.test.ts

**Interfaces:**
- Consumes: runtime_resources, SessionPresentationGenerator, workflow run Goal Contract/outcome summary.
- Produces: getSessionPresentationPg(), persistSessionPresentationRevisionPg(), requestSessionPresentationGenerationPg(), processPendingSessionPresentationsPg().

- [ ] **Step 1: Add failing persistence and loop tests**

~~~ts
test('Operator presentation revisions are append-only and current projection is deterministic', async () => {
  await withDb(async (db) => {
    await persistSessionPresentationRevisionPg(db, presentation({ subjectId: 'run-1', revision: 1 }));
    await persistSessionPresentationRevisionPg(db, presentation({
      subjectId: 'run-1',
      revision: 2,
      parentSubjectId: undefined,
      title: 'Confirmed goal title',
    }));
    const current = await getSessionPresentationPg(db, 'operator', 'run-1');
    assert.equal(current!.revision, 2);
    assert.equal(current!.title, 'Confirmed goal title');
  });
});

test('generation request is idempotent by subject and source hash', async () => {
  await withDb(async (db) => {
    const first = await requestSessionPresentationGenerationPg(db, sourcePacket({
      surface: 'operator',
      subjectId: 'run-1',
    }));
    const replay = await requestSessionPresentationGenerationPg(db, sourcePacket({
      surface: 'operator',
      subjectId: 'run-1',
    }));
    assert.equal(first.requestId, replay.requestId);
  });
});

test('generation loop persists LLM proposal without overwriting manual locks', async () => {
  await withDb(async (db) => {
    await persistSessionPresentationRevisionPg(db, manualOperatorPresentation());
    await requestSessionPresentationGenerationPg(db, operatorSourcePacket());
    const result = await processPendingSessionPresentationsPg(db, {
      generator: fixedGenerator(generatedProposal()),
      limit: 10,
    });
    assert.equal(result.completed, 1);
    const current = await getSessionPresentationPg(db, 'operator', 'run-1');
    assert.equal(current!.title, 'Manual run title');
    assert.equal(current!.purposeSummary, generatedProposal().purposeSummary);
  });
});
~~~

- [ ] **Step 2: Run Postgres tests and verify red**

Run: npx tsx tests/v2/postgres-session-presentation.test.ts

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Store revisions and pending requests in runtime_resources**

Use resource types session_presentation_revision and session_presentation_generation. Revision keys are surface:subjectId:revision; generation keys are surface:subjectId:sourceHash. Current projection selects the highest valid revision. Generation rows transition pending → processing → completed | failed with an attempt lease; retries preserve the same request id.

- [ ] **Step 4: Add the bounded generation processor**

~~~ts
export type ProcessPendingSessionPresentationsPg = (
  db: SouthstarDb,
  input: {
    generator: SessionPresentationGenerator;
    limit: number;
    now?: string;
  },
) => Promise<{ completed: number; failed: number }>;
~~~

Implement claim/call/persist with the same lease pattern used by existing durable runtime loops. Failure stores a concise non-secret error and leaves fallback presentation untouched.

- [ ] **Step 5: Enqueue Operator requests at meaningful transitions**

At run creation persist a fallback presentation from the frozen Goal summary and enqueue a source packet. At terminal outcome enqueue a new source hash containing outcomeSummary. Do not enqueue on heartbeat, task update or operator overview read.

- [ ] **Step 6: Register the loop and run tests**

Run: npx tsx tests/v2/postgres-session-presentation.test.ts && npx tsx tests/v2/postgres-run-api.test.ts

Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add src/v2/session-presentation/postgres-store.ts src/v2/session-presentation/generation-loop.ts src/v2/server/runtime-loop-registry.ts src/v2/server/runtime-loops.ts src/v2/ui-api/postgres-run-api.ts tests/v2/postgres-session-presentation.test.ts tests/v2/index.test.ts
git commit -m "feat: persist operator session presentations"
~~~

---

### Task 3: Operator Read Model, Edit and Regenerate Routes

**Files:**
- Create: src/v2/server/session-presentation-routes.ts
- Modify: src/v2/server/routes.ts
- Modify: src/v2/server/http-server.ts
- Modify: src/v2/server/client.ts
- Modify: src/v2/read-models/operator-overview.ts
- Modify: src/v2/read-models/operator-attention.ts
- Modify: tests/v2/operator-overview-read-model.test.ts
- Modify: tests/v2/session-routes.test.ts

**Interfaces:**
- Consumes: Operator presentation Postgres adapter.
- Produces: OperatorRun.presentation, PATCH /api/v2/session-presentations/operator/:runId, POST .../regenerate.

- [ ] **Step 1: Add failing read-model and route tests**

~~~ts
test('operator overview separates semantic presentation from dynamic run facts', async () => {
  await withDb(async (db) => {
    await createRun(db, { runId: 'run-1', goalPrompt: 'Raw goal prompt', status: 'running' });
    await persistSessionPresentationRevisionPg(db, presentation({
      surface: 'operator',
      subjectId: 'run-1',
      title: 'Offline article verification',
      purposeSummary: 'Create and verify an offline article.',
    }));
    const overview = await loadOperatorOverviewPg(db);
    assert.equal(overview.runs[0]!.title, 'Offline article verification');
    assert.equal(overview.runs[0]!.presentation!.purposeSummary, 'Create and verify an offline article.');
    assert.equal(overview.runs[0]!.status, 'running');
  });
});

test('manual Operator edit locks only supplied fields', async () => {
  const response = await requestRuntime('PATCH', '/api/v2/session-presentations/operator/run-1', {
    expectedRevision: 1,
    patch: { title: 'Manual title' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.presentation.manualLocks, ['title']);
});
~~~

- [ ] **Step 2: Run read-model/route tests and verify red**

Run: npx tsx tests/v2/operator-overview-read-model.test.ts && npx tsx tests/v2/session-routes.test.ts

Expected: FAIL because presentation projection/routes are missing.

- [ ] **Step 3: Project presentation without changing run truth**

Extend OperatorRun read model with presentation. title uses presentation.title then goal_prompt fallback. Keep status, outcomeStatus, healthStatus, attention count, cwd and updatedAt from existing host sources. Do not store dynamic facts in the presentation resource.

- [ ] **Step 4: Add edit/regenerate routes**

PATCH accepts exact title/purposeSummary/reuseHint/keywords keys and expectedRevision, merges manual locks and persists a revision. Regenerate accepts fields to unlock plus expectedRevision, writes a durable generation request and returns 202. Return 409 on stale revision and 404 for unknown run.

- [ ] **Step 5: Run focused tests**

Run: npx tsx tests/v2/operator-overview-read-model.test.ts && npx tsx tests/v2/session-routes.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/server/session-presentation-routes.ts src/v2/server/routes.ts src/v2/server/http-server.ts src/v2/server/client.ts src/v2/read-models/operator-overview.ts src/v2/read-models/operator-attention.ts tests/v2/operator-overview-read-model.test.ts tests/v2/session-routes.test.ts
git commit -m "feat: expose operator session presentation metadata"
~~~

---

### Task 4: Pi Session Presentation Adapter and Web Routes

**Files:**
- Create: web/lib/session-presentation.ts
- Create: web/app/api/sessions/[id]/presentation/route.ts
- Create: web/app/api/sessions/[id]/presentation/generate/route.ts
- Create: tests/web/southstar-session-presentation-route.test.ts
- Modify: web/lib/types.ts
- Modify: web/lib/session-reader.ts
- Modify: web/app/api/sessions/route.ts
- Modify: web/app/api/sessions/[id]/route.ts

**Interfaces:**
- Consumes: SessionManager.appendCustomEntry(), runtime SessionPresentationGenerator route/client.
- Produces: SOUTHSTAR_SESSION_PRESENTATION_CUSTOM_TYPE, readLatestPiSessionPresentation(), appendPiSessionPresentation(), SessionInfo.presentation.

- [ ] **Step 1: Add failing Pi adapter/API tests**

~~~ts
test('session reader returns the latest valid append-only presentation revision', async () => {
  const session = await createPiSession();
  appendPresentationEntry(session, presentation({ revision: 1, title: 'First title' }));
  appendPresentationEntry(session, presentation({ revision: 2, title: 'Current title' }));
  const listed = await listAllSessions();
  const info = listed.find((item) => item.id === session.getSessionId())!;
  assert.equal(info.presentation!.revision, 2);
  assert.equal(info.presentation!.title, 'Current title');
});

test('PATCH presentation appends a manual revision and leaves earlier entries unchanged', async () => {
  const session = await createPiSession();
  appendPresentationEntry(session, presentation({ revision: 1 }));
  const response = await patchSessionPresentation(session.getSessionId(), {
    expectedRevision: 1,
    patch: { title: 'Manual Library title' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.presentation.revision, 2);
  assert.deepEqual(response.body.presentation.manualLocks, ['title']);
  assert.equal(readAllPresentationEntries(session).length, 2);
});
~~~

- [ ] **Step 2: Run route tests and verify red**

Run: npx tsx tests/web/southstar-session-presentation-route.test.ts

Expected: FAIL because Pi presentation adapter/routes are missing.

- [ ] **Step 3: Add custom entry adapter**

~~~ts
export const SOUTHSTAR_SESSION_PRESENTATION_CUSTOM_TYPE =
  'southstar.session_presentation.v1';

export function readLatestPiSessionPresentation(
  entries: SessionEntry[],
): SessionPresentationV1 | undefined {
  return entries
    .filter((entry): entry is CustomEntry =>
      entry.type === 'custom' &&
      entry.customType === SOUTHSTAR_SESSION_PRESENTATION_CUSTOM_TYPE)
    .map((entry) => parseSessionPresentation(entry.data))
    .filter((value): value is SessionPresentationV1 => Boolean(value))
    .sort((left, right) => right.revision - left.revision)[0];
}
~~~

appendPiSessionPresentation() opens the existing SessionManager and calls appendCustomEntry() with the canonical object. Extend SessionInfo with presentation and populate it in both full-list and compact recent-session paths. Existing name and firstMessage remain fallback fields.

- [ ] **Step 4: Add read/edit/generate routes**

GET returns current presentation plus fallback view. PATCH performs expectedRevision/manual lock merge and appends one custom entry. POST generate builds a bounded packet from session kind, first meaningful user intent, current Goal/Library custom blocks and parent presentation; it calls the runtime proposal endpoint, merges unlocked fields and appends one revision.

Do not include assistant readiness text, raw tool results or more than the bounded semantic fields. The route can run after the triggering user request without blocking the sidebar; failure returns fallback and does not mutate the session.

- [ ] **Step 5: Preserve existing rename behavior**

PATCH /api/sessions/:id with name remains compatible, but also appends a presentation revision with manual title lock when a presentation exists. If none exists, create a fallback revision with the manual title and empty-safe purpose/reuse defaults derived from existing firstMessage.

- [ ] **Step 6: Run route/session tests**

Run: npx tsx tests/web/southstar-session-presentation-route.test.ts && npx tsx tests/web/southstar-session-export-route.test.ts

Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add web/lib/session-presentation.ts web/lib/types.ts web/lib/session-reader.ts web/app/api/sessions/route.ts web/app/api/sessions/[id]/route.ts web/app/api/sessions/[id]/presentation/route.ts web/app/api/sessions/[id]/presentation/generate/route.ts tests/web/southstar-session-presentation-route.test.ts
git commit -m "feat: persist semantic metadata in pi sessions"
~~~

---

### Task 5: Shared Tooltip, Editor and Three Sidebar Integrations

**Files:**
- Create: web/components/SessionPresentationTooltip.tsx
- Create: web/components/SessionPresentationEditor.tsx
- Create: tests/web/southstar-session-presentation-ui.test.tsx
- Modify: web/components/library/LibrarySidebar.tsx
- Modify: web/components/library/LibraryWorkspace.tsx
- Modify: web/components/WorkflowSidebar.tsx
- Modify: web/components/operator/OperatorSidebar.tsx
- Modify: web/lib/operator/types.ts
- Modify: tests/web/southstar-library-sidebar-layout.test.tsx
- Modify: tests/web/southstar-workflow-canvas-ui.test.tsx
- Modify: tests/web/southstar-web-operator-control-tower.test.tsx

**Interfaces:**
- Consumes: SessionInfo.presentation, OperatorRun.presentation, dynamic host facts.
- Produces: buildSessionPresentationTooltipView(), accessible tooltip, edit/regenerate/restore UI.

- [ ] **Step 1: Add failing shared rendering tests**

~~~tsx
test('Library and Workflow rows show semantic title with accessible tooltip content', async () => {
  await renderThreeSidebarHarness({
    presentation: presentation({
      title: 'Offline article workflow',
      purposeSummary: 'Create and verify a self-contained article.',
      reuseHint: 'Resume Goal Design or fork for another article.',
    }),
  });
  const workflowRow = screen.getByTestId('workflow-session-session-1');
  assert.match(workflowRow.textContent ?? '', /Offline article workflow/);
  workflowRow.focus();
  assert.match(screen.getByRole('tooltip').textContent ?? '', /Resume Goal Design/);
});

test('Operator tooltip combines semantic purpose with host-owned status and attention', async () => {
  await renderOperatorSidebar({
    run: operatorRun({
      status: 'running',
      presentation: presentation({ purposeSummary: 'Verify the offline article.' }),
    }),
    incidents: [incident()],
  });
  focusRun('run-1');
  const tooltip = screen.getByRole('tooltip');
  assert.match(tooltip.textContent ?? '', /Verify the offline article/);
  assert.match(tooltip.textContent ?? '', /Status: running/);
  assert.match(tooltip.textContent ?? '', /Attention: 1/);
});

test('manual edit submits only changed fields and regenerate selects unlocked fields', async () => {
  await openPresentationEditor();
  changeField('title', 'Manual title');
  click('[data-testid="session-presentation-save"]');
  assert.deepEqual(lastPatchBody(), {
    expectedRevision: 2,
    patch: { title: 'Manual title' },
  });
});
~~~

- [ ] **Step 2: Run shared UI tests and verify red**

Run: npx tsx tests/web/southstar-session-presentation-ui.test.tsx

Expected: FAIL because shared tooltip/editor components are missing.

- [ ] **Step 3: Build tooltip view model and accessible component**

~~~ts
export type SessionPresentationTooltipView = {
  title: string;
  purposeSummary: string;
  reuseHint: string;
  projectLabel?: string;
  status?: string;
  updatedLabel: string;
  attentionCount?: number;
};
~~~

The row displays only compact title plus existing time/count/status badges. SessionPresentationTooltip opens on hover and keyboard focus, uses role=tooltip and aria-describedby, and renders LLM semantic fields plus host facts passed by the caller.

- [ ] **Step 4: Add shared edit/regenerate UI**

SessionPresentationEditor edits title, purposeSummary, reuseHint and keywords; shows manual lock state and revision. Save sends changed fields only. Regenerate lets the user select fields to unlock/regenerate. Restore selects a previous revision returned by the presentation route. Reuse existing inline/sidecar interaction patterns; do not add a page.

- [ ] **Step 5: Integrate each existing sidebar**

Library and Workflow use session.presentation with name/firstMessage fallback. Operator uses run.presentation with goal title fallback. Remove no existing status/time/count/attention behavior. Replace window.prompt rename with the shared editor only after tests cover keyboard/mouse actions.

- [ ] **Step 6: Run sidebar and web build gates**

Run:

~~~bash
npx tsx tests/web/southstar-session-presentation-ui.test.tsx
npx tsx tests/web/southstar-library-sidebar-layout.test.tsx
npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
npm --prefix web run build
~~~

Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add web/components/SessionPresentationTooltip.tsx web/components/SessionPresentationEditor.tsx web/components/library/LibrarySidebar.tsx web/components/library/LibraryWorkspace.tsx web/components/WorkflowSidebar.tsx web/components/operator/OperatorSidebar.tsx web/lib/operator/types.ts tests/web/southstar-session-presentation-ui.test.tsx tests/web/southstar-library-sidebar-layout.test.tsx tests/web/southstar-workflow-canvas-ui.test.tsx tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "feat: show reusable session identity in sidebars"
~~~

---

### Task 6: Meaningful Generation Triggers, Fork Lineage and Regression Gates

**Files:**
- Modify: web/hooks/useAgentSession.ts
- Modify: web/components/library/LibraryWorkspace.tsx
- Modify: web/lib/rpc-manager.ts
- Modify: web/lib/session-reader.ts
- Modify: src/v2/ui-api/postgres-run-api.ts
- Modify: tests/web/southstar-session-presentation-route.test.ts
- Modify: tests/web/southstar-session-presentation-ui.test.tsx
- Modify: tests/v2/postgres-session-presentation.test.ts

**Interfaces:**
- Consumes: Pi generate route, Operator durable request store, parentSessionId.
- Produces: lifecycle-triggered, idempotent background generation with fallback and lineage.

- [ ] **Step 1: Add failing trigger and fork tests**

~~~ts
test('Workflow title generation runs after first meaningful Goal and confirmed Goal Contract only', async () => {
  const calls = installPresentationGenerateRecorder();
  await submitWorkflowGoal('Create an offline article');
  await emitPlannerStage('goal_contract.interpreted', {
    summary: 'Create and verify an offline article',
  });
  await emitPlannerStage('task.running', {});
  assert.equal(calls.filter((call) => call.reason === 'first-meaningful-intent').length, 1);
  assert.equal(calls.filter((call) => call.reason === 'goal-contract-confirmed').length, 1);
  assert.equal(calls.some((call) => call.reason === 'task.running'), false);
});

test('Library generation excludes readiness diagnostics and runs after import intent/approval', async () => {
  const packet = await buildLibraryPresentationPacket(sessionWithMessages([
    userMessage('Import vocabulary evaluators'),
    assistantMessage('Library ready 428d46 59 included 325 excluded'),
  ]));
  assert.equal(packet.firstMeaningfulIntent, 'Import vocabulary evaluators');
  assert.doesNotMatch(JSON.stringify(packet), /59 included|325 excluded/);
});

test('fork starts with parent provisional identity and regenerates after child intent', async () => {
  const child = await forkSession(parentWithPresentation());
  assert.equal(child.presentation!.parentSubjectId, parentSessionId());
  assert.equal(child.presentation!.source, 'fallback');
  await submitChildIntent(child.id, 'Adapt this workflow for another article');
  assert.equal(generateCallsFor(child.id), 1);
});
~~~

- [ ] **Step 2: Run trigger tests and verify red**

Run: npx tsx tests/web/southstar-session-presentation-route.test.ts && npx tsx tests/v2/postgres-session-presentation.test.ts

Expected: FAIL because lifecycle triggers/lineage are missing.

- [ ] **Step 3: Add non-blocking Pi triggers**

After ensureNewSession()/first meaningful user message persistence, call the Pi presentation generate route without awaiting it in the message send path; catch and ignore failure after recording a client diagnostic. Repeat only on Goal Contract confirmed and Library candidate/import approved events when the source hash changes. Do not trigger from readiness, heartbeat, progress, task or list refresh events.

- [ ] **Step 4: Preserve fork lineage**

When rpc-manager creates a fork, append a provisional presentation with parentSubjectId, parent title/purpose, source=fallback and no manual locks. The first meaningful child message generates a distinct source hash and revision; the parent remains unchanged.

- [ ] **Step 5: Verify Operator transitions remain durable**

Run creation and terminal outcome enqueue requests through Task 2; no unawaited runtime promise may perform Operator persistence. Test duplicate terminal callbacks create one source-hash request.

- [ ] **Step 6: Run focused and broad local gates**

Run:

~~~bash
npx tsx tests/v2/session-presentation.test.ts
npx tsx tests/v2/postgres-session-presentation.test.ts
npx tsx tests/v2/operator-overview-read-model.test.ts
npx tsx tests/web/southstar-session-presentation-route.test.ts
npx tsx tests/web/southstar-session-presentation-ui.test.tsx
npm run test:v2
npm --prefix web run build
~~~

Expected: all exit 0. Do not run live browser/runtime integrations in this task.

- [ ] **Step 7: Inspect LLM list-path and sensitive-source regressions**

Run:

~~~bash
rg -n 'generateText|sessionPresentationGenerator' web/components/WorkflowSidebar.tsx web/components/library/LibrarySidebar.tsx web/components/operator/OperatorSidebar.tsx web/app/api/sessions/route.ts src/v2/read-models/operator-overview.ts
rg -n 'readiness\\.diagnostics|raw.*log|stack.*trace|vault|credential' src/v2/session-presentation web/lib/session-presentation.ts
~~~

Expected: no generator call in sidebar/list/read-model paths and no sensitive/raw diagnostic fields in source packet construction.

- [ ] **Step 8: Commit**

~~~bash
git add web/hooks/useAgentSession.ts web/components/library/LibraryWorkspace.tsx web/lib/rpc-manager.ts web/lib/session-reader.ts src/v2/ui-api/postgres-run-api.ts tests/web/southstar-session-presentation-route.test.ts tests/web/southstar-session-presentation-ui.test.tsx tests/v2/postgres-session-presentation.test.ts
git commit -m "feat: generate session identity at meaningful transitions"
~~~

---

## Execution Order and Review Gates

Execute Tasks 1–6 in order. Task 1 defines the shared contract; Tasks 2–3 complete the Operator adapter; Task 4 completes the Pi adapter; Task 5 integrates the three existing sidebars; Task 6 adds lifecycle triggers and broad regression gates.

After every task:

1. run the exact focused tests;
2. inspect git diff --check and git status --short;
3. confirm no sidebar/list read path calls LLM;
4. confirm only listed files changed;
5. commit the independently testable result;
6. stop on any red gate.
