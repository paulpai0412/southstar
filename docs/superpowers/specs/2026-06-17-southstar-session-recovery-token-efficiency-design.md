# Southstar Session Recovery and Token Efficiency Design

> Date: 2026-06-17  
> Status: approved design draft  
> Scope: Southstar v2 runtime, session graph, context rebuild, recovery commands, Pi-native optimization, and real E2E validation.

## 1. Problem

Southstar v2 already records session nodes, checkpoints, recovery decisions, context packets, task envelopes, and worktree rollback resources. The current implementation is durable enough to inspect what happened, but it does not yet provide true end-to-end recovery semantics for session `fork`, `reset`, `rollback`, or host-native `rewind`.

Current gaps:

- Checkpoints are thin. They mostly store pointers such as `contextPacketId`, `artifactRefs`, and summaries. They do not consistently capture enough compact state for high-quality recovery.
- UI recovery commands often record intent but do not dispatch a real recovery attempt.
- Existing context refresh updates the envelope context packet but can fail to regenerate a matching prompt, so refreshed context may not reach the agent prompt used by the Pi harness.
- `before-recovery` is declared in session policy but is not wired as an automatic checkpoint point.
- Token savings are not observable across recovery attempts.
- Host-native rewind/fork capabilities are not modeled, so Southstar cannot use Pi session features as an optimization while preserving Southstar as the durable source of truth.

The design goal is to make recovery real, auditable, and token-efficient without making correctness depend on any single host runtime.

## 2. External Principles Used

The design follows practical Claude/agent efficiency patterns found in public discussions and articles:

- Failed conversation suffixes should not be carried forever. Rewind-like behavior saves tokens by removing failed paths from future context while preserving useful prefix/cache when a host supports it.
- Long sessions suffer from context compounding and context rot. Cost and quality both degrade as irrelevant tool results, failed attempts, and stale decisions accumulate.
- Durable state should live outside the LLM transcript. Checkpoints should store compact decisions, refs, summaries, and telemetry rather than raw transcripts.
- Progressive disclosure reduces prompt cost. Recovery prompts should use summaries and refs first, loading full artifacts/files only when needed.
- Session continuity matters for correctness, but it should not require preserving every failed token.

Reference sources used during design research:

- MindStudio: Claude Code token management and `/rewind` discussions.
- Public X discussion quoting Claude Code session management guidance around cache reads/writes and rewind.
- Reddit / ClaudeCode discussions about context rot, compaction, handoff prompts, and checkpointing.
- Context engineering articles describing cumulative agent context cost and quality degradation.

These sources guide the design but do not replace Southstar runtime invariants.

## 3. Chosen Approach

Use **Durable-first + Pi-native optimization**.

Southstar durable state is the source of truth. Pi-native session features are optional accelerators.

Every recovery action must first commit durable Southstar facts:

1. `recovery_decision`
2. `before-recovery` `session_checkpoint`
3. rebuilt immutable `context_packet`
4. matching `task_envelope` and `agentPrompt`
5. lineage from old session to checkpoint to new attempt/session

After those facts exist, the runtime chooses an execution path:

```text
Recovery requested
  -> write recovery_decision
  -> create before-recovery checkpoint
  -> build compact recovery context
  -> choose execution path
       Path A: Pi-native if supported and safe
       Path B: Southstar-native replay fallback
```

This gives Southstar deterministic correctness and auditability while still allowing Pi-native rewind/fork/resume to reduce token cost when available.

## 4. Phased v1 Delivery

### Phase 1: Southstar-native recovery MVP

Deliver durable recovery semantics without requiring host-native session support.

Required capabilities:

- richer checkpoint payloads
- automatic `before-recovery` checkpoint creation
- `retry-same-agent` with compact recovery context
- `fork-from-checkpoint`
- `rollback-workspace` as a real git/worktree operation followed by recovery dispatch
- token telemetry for recovery attempts
- read model support for lineage and recovery edges

### Phase 2: Pi-native reset / rewind / fork optimization

Add Pi capability support as an optimization.

Required capabilities:

- Pi session capability detection for resume/fork/rewind-like behavior
- host-native operation records
- `reset-from-checkpoint`
- `host-native-rewind` when the Pi session is live and checkpoint anchoring is safe
- fallback to Southstar-native replay when Pi-native operation fails or is unsupported
- evidence for host operation success/failure

### Phase 3: Cost-aware orchestration

Add observability and operator guidance. v1 does not enforce token reduction gates.

Required capabilities:

- per-attempt token estimates
- checkpoint summary token estimates
- omitted failure suffix estimates
- rebuilt context estimates
- estimated savings
- branch pruning recommendations
- inefficient recovery warnings only; no hard blocking threshold

## 5. Action Semantics and Trigger Rules

### 5.1 Checkpoint

A checkpoint is a durable compact anchor. It is not a full transcript snapshot.

#### `task-start` checkpoint

Created after task envelope materialization and before executor submission.

Use when:

- the executor crashes or callback is missing
- a task needs replay from a clean start
- fork/reset needs a clean base

Must capture:

- context packet id
- task envelope id
- workspace snapshot ref if available
- selected memory refs or summary
- upstream artifact refs
- prompt token estimate
- host session anchor if known

#### `artifact-accepted` checkpoint

Created after artifact acceptance and evaluator success.

Use when:

- downstream tasks need compact upstream context
- workflow revision should preserve accepted work
- a later branch should start from an accepted result

Must capture:

- accepted artifact refs
- evidence packet refs
- validator result refs
- artifact summary
- post-acceptance workspace snapshot ref when workspace policy requires it
- token telemetry

#### `before-recovery` checkpoint

Created before any recovery execution: retry, fork, reset, rewind, or workspace rollback.

Use when:

- preserving failure facts for audit
- excluding the failed suffix from the next prompt
- generating failure lessons or branch pruning recommendations

Must capture:

- failing artifact/validator/evidence refs
- compact failure summary
- attempted approach summary
- dirty workspace snapshot when applicable
- omitted failure suffix estimate
- selected recovery strategy

### 5.2 Retry

`retry-same-agent` is for repairable, low-risk failures.

Use when:

- artifact JSON is malformed
- required fields are missing
- evidence is incomplete
- a command/test was not run
- evaluator findings indicate a small repair rather than a wrong approach

Do not use when:

- the implementation approach is wrong
- workspace state is corrupted
- the checker rejects the direction
- repeated retries fail in the same way

Semantics:

```text
same task
same logical lineage
new attempt
compact failure summary included
full failed transcript excluded
```

### 5.3 Fork

`fork-from-checkpoint` creates a new branch while preserving the old branch.

Use when:

- checker rejects the approach but the branch should remain inspectable
- operator wants to compare alternatives
- evaluator recommends a new strategy from a clean checkpoint
- parallel exploration is valuable

Do not use when:

- the only problem is a missing artifact field
- the current branch should be discarded rather than preserved
- workspace must be restored first

Semantics:

```text
old session remains inspectable
checkpoint is branch base
new session_node has parentSessionId and baseCheckpointId
new context_packet and task_envelope are created
new attempt is dispatched
```

### 5.4 Reset

`reset-from-checkpoint` discards the current active branch as the path forward and restarts from a checkpoint.

Use when:

- the current branch is no longer useful
- the agent loops or context rot is suspected
- the failed suffix is mostly noise
- retry attempts are exhausted but a clean retry is still appropriate

Do not use when:

- the old branch should remain active for comparison
- git workspace state must be restored without a workspace rollback
- checkpoint ownership is ambiguous

Semantics:

```text
old active session marked superseded
new session starts from checkpoint
failed suffix excluded
same task continues with new attempt/session
```

### 5.5 Rewind

`host-native-rewind` is a Pi optimization, not a Southstar source of truth.

Use when:

- Pi session is live
- Pi reports rewind/resume/fork capability
- checkpoint has a safe host session anchor
- failure is mostly conversation suffix, not workspace corruption
- token savings are expected from preserving useful prefix/cache

Do not use when:

- Pi session is missing or unknown
- checkpoint cannot be mapped to a host anchor
- workspace rollback is required
- cross-host replay is needed

Semantics:

```text
Southstar commits recovery decision and checkpoint
Pi attempts native rewind/fork/resume
success -> compact prompt dispatched from host-native state
failure -> Southstar-native replay fallback
```

### 5.6 Rollback

There are two different rollback meanings.

#### Session rollback

A lineage operation that points recovery at a checkpoint. It does not necessarily modify files.

Use when:

- operator wants to recover from a logical checkpoint
- lineage must show the recovery base
- reset/fork/replay needs an explicit checkpoint target

#### Workspace rollback

A destructive git/worktree operation that restores file state.

Use when:

- implementation changed the wrong files
- tests fail because of workspace mutations
- checker rejects a workspace-changing approach
- recovery must run from a clean git snapshot

Required flow:

```text
create workspace snapshot
-> rollback preview
-> operator approval or policy authorization
-> apply git rollback
-> record worktree_rollback
-> dispatch recovery attempt
```

Do not use for pure prompt, JSON format, or artifact evidence failures.

## 6. Trigger Authority

LLMs may suggest recovery. They may not commit recovery.

```text
LLM suggests.
Evaluator classifies.
Policy authorizes.
Southstar commits.
Executor performs.
Callback verifies.
```

### LLM / agent

May provide:

- failure summary
- recommended recovery strategy
- confidence and reason
- compact checkpoint summary candidates

May not:

- mutate runtime state
- directly apply git rollback
- directly fork/reset/rewind sessions
- bypass recovery policy

### Program / evaluator / policy

Must decide and commit recovery actions using validated facts:

- artifact status
- evaluator findings
- validator results
- evidence completeness
- executor observations
- retry count
- checkpoint availability
- workspace snapshot availability
- host capability
- operator approval policy

### Operator

May request, approve, or override recovery actions through UI/API. The action still passes through Southstar validation and durable commit.

### Automatic levels

Level 1 auto-safe:

- malformed artifact -> retry
- missing required field -> retry
- missing evidence -> retry
- executor crash/callback missing -> replay from checkpoint

Level 2 semi-automatic:

- checker reject -> fork candidate
- retry exhausted -> reset candidate
- context rot suspected -> reset/rewind candidate
- failed tests -> workspace rollback candidate

Level 3 operator approval required:

- destructive git rollback
- branch pruning/deletion
- workflow revision changing DAG
- reset with uncommitted accepted artifacts
- host-native rewind with ambiguous anchor

## 7. Data Model Contracts

Do not add new tables for v1. Store new records in `runtime_resources` and audit events in `workflow_history`.

### 7.1 `session_checkpoint` payload

```ts
type SessionCheckpointV1 = {
  schemaVersion: "southstar.session-checkpoint.v1";
  checkpointId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  kind: "task-start" | "artifact-accepted" | "before-recovery" | "manual";
  createdBy: "orchestrator" | "evaluator" | "operator" | "root-session";
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefs: string[];
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
  workspaceSnapshotRef?: string;
  hostSessionAnchor?: {
    host: "pi" | "codex" | "claude-code" | "custom";
    rootSessionId?: string;
    streamSessionId?: string;
    providerCheckpointId?: string;
    rewindSupported?: boolean;
  };
  summaries: {
    checkpointSummary: string;
    decisions: string[];
    filesTouched: string[];
    filesInspected: string[];
    failureSummary?: string;
    attemptedApproach?: string;
    nextAttemptHint?: string;
  };
  tokenTelemetry: {
    contextTokenEstimate: number;
    checkpointSummaryTokenEstimate: number;
    failureSuffixTokenEstimate?: number;
  };
  policy: {
    safeForAutoRetry: boolean;
    safeForFork: boolean;
    safeForReset: boolean;
    safeForWorkspaceRollback: boolean;
  };
};
```

### 7.2 `recovery_decision` payload

```ts
type RecoveryDecisionV1 = {
  schemaVersion: "southstar.recovery-decision.v1";
  decisionId: string;
  runId: string;
  taskId: string;
  source: "evaluator" | "operator" | "executor-observation" | "agent-suggestion";
  requestedStrategy:
    | "retry-same-agent"
    | "fork-from-checkpoint"
    | "reset-from-checkpoint"
    | "host-native-rewind"
    | "rollback-workspace"
    | "request-workflow-revision"
    | "ask-human";
  selectedStrategy: string;
  baseCheckpointId?: string;
  beforeRecoveryCheckpointId: string;
  reason: string;
  evaluatorFindingRefs: string[];
  agentSuggestion?: {
    strategy: string;
    confidence?: "low" | "medium" | "high";
    reason: string;
  };
  authorization: {
    mode: "auto" | "operator-approved" | "blocked";
    approvalRef?: string;
    policyReasons: string[];
  };
  execution: {
    status: "queued" | "running" | "succeeded" | "failed" | "fallback-used";
    hostPath?: "pi-native" | "southstar-native";
    fallbackReason?: string;
    newSessionId?: string;
    newTaskEnvelopeId?: string;
  };
  tokenTelemetry: {
    originalContextTokenEstimate?: number;
    rebuiltContextTokenEstimate?: number;
    omittedFailureSuffixEstimate?: number;
    estimatedSavings?: number;
  };
};
```

### 7.3 `session_operation` payload

Add resource type `session_operation`.

```ts
type SessionOperationV1 = {
  operationId: string;
  runId: string;
  taskId: string;
  type: "fork" | "reset" | "rewind" | "replay";
  baseCheckpointId: string;
  oldSessionId?: string;
  newSessionId?: string;
  host: "pi" | "southstar-native";
  status: "queued" | "succeeded" | "failed";
  fallbackUsed: boolean;
  error?: string;
};
```

## 8. API Contracts

Keep existing routes and strengthen their semantics.

Task recovery routes:

```text
POST /api/v2/runs/:runId/tasks/:taskId/retry
POST /api/v2/runs/:runId/tasks/:taskId/fork-session
POST /api/v2/runs/:runId/tasks/:taskId/rollback-workspace
POST /api/v2/runs/:runId/tasks/:taskId/request-revision
```

Session operation routes:

```text
POST /api/v2/sessions/:sessionId/fork
POST /api/v2/sessions/:sessionId/reset
POST /api/v2/sessions/:sessionId/rollback
POST /api/v2/sessions/:sessionId/rewind
```

`rewind` is distinct from `rollback`:

- `rewind`: host-native optimization candidate
- `reset`: Southstar semantic restart from checkpoint
- `rollback`: lineage recovery to checkpoint
- `rollback-workspace`: git/worktree operation

Request payloads should accept:

```json
{
  "commandId": "cmd-123",
  "actor": { "type": "user", "id": "operator" },
  "payload": {
    "checkpointId": "checkpoint-...",
    "reason": "checker rejected approach",
    "dryRun": false
  }
}
```

Command responses should include created resource refs, event refs, and next suggested actions.

## 9. Context Refresh Compatibility

Existing context refresh is normal execution behavior. It should remain separate from recovery rebuild.

Define three context operations:

1. **Refresh**: just-in-time upstream artifact refresh for normal execution.
2. **Rebuild**: checkpoint-aware context generation for retry/fork/reset/rollback recovery.
3. **Rewind**: host-native attempt to remove conversation suffix; still followed by a Southstar-recorded compact prompt/context.

Rules:

- Context packets are immutable. Recovery creates a new packet instead of mutating the old one.
- Any refreshed or rebuilt `context_packet` must have a matching rendered `task_envelope.agentPrompt`.
- If `refreshEnvelopeContext` updates `contextPacket.priorArtifacts`, it must also regenerate or defer-render the prompt so the Pi harness sees the refreshed context.
- Normal upstream refresh does not create a recovery decision.
- Recovery rebuild always creates a recovery decision and `before-recovery` checkpoint.

## 10. Error Handling

| Error | Required behavior |
|---|---|
| Missing checkpoint | Reject command, append audit event, dispatch nothing. |
| Cross-run checkpoint | Reject; checkpoint must belong to the same run. |
| Cross-task checkpoint without explicit policy | Reject unless workflow revision policy permits cross-task recovery. |
| Pi-native capability unsupported | Record failed `session_operation`, fallback to Southstar-native replay. |
| Pi session missing | Fallback to Southstar-native replay. |
| Ambiguous host checkpoint anchor | Block host-native rewind; require operator or fallback. |
| Workspace rollback without preview | Reject and suggest rollback-preview. |
| Context rebuild exceeds budget | Compress once; if still over budget, block recovery and ask human. |
| Late callback from superseded branch | Preserve as audit; do not overwrite active branch state. |
| Recovery attempt succeeds on stale branch | Mark as stale/superseded unless operator accepts branch. |

## 11. Real E2E Requirement

The v1 implementation must include real E2E tests. Fake, mock, and smoke-only tests are insufficient for acceptance.

Hard rules:

- Do not use fake adapters for the acceptance E2E.
- Do not mock callbacks.
- Do not use smoke-only endpoint checks as proof of recovery.
- Do not use the calc toy fixture or calc command scenario.
- Callback must be emitted by the real runner path.
- Workspace rollback must perform real git operations.
- SQLite must contain checkpoint, recovery decision, context packet, task envelope, lineage, token telemetry, artifact/evidence, and callback evidence.

### Base E2E: Design Library real scenario

Use the existing real E2E family as the basis for session management tests:

- Scenario: `tests/e2e-real/scenarios/design-library-template-real.ts`
- Test entry: `tests/e2e-real/design-library-template-real.test.ts`
- Fixture repo helper: `prepareTodoWebFeatureIssueRepo(...)`
- Fixture issue: `todoWebFeatureIssuePacket(repo)`
- Runtime path: Design Library seed -> issue workflow draft -> patch -> approve template -> compile manifest -> `createRunFromDraft` -> real Tork/Docker execution -> real Pi harness/planner path -> callback ingestion -> template validation from run.

The base scenario already enforces important non-toy constraints:

- no calc helpers or calc fixture
- no fake/mock/smoke/builtin shortcut in the scenario source
- Pi planner and Pi harness mode must be `http` or `sdk`
- tasks use Pi harness definitions
- accepted artifacts, complete evidence packets, validator results, stop condition, executor bindings, and `template.validated_from_run` evidence are required
- the target repo is a todo-web feature issue with real TypeScript app files, tests, README, localStorage behavior, and browser verification

Session-management E2E must extend this base scenario instead of introducing a separate JSON-schema fixture. The resulting tests should remain Design Library aware: compiled templates, agent specs, skills, contracts, validators, and template lifecycle evidence must still be present after recovery.

### E2E Case 1: Design Library real compact retry

Purpose: verify `retry-same-agent` with compact context on the Design Library todo-web workflow.

Failure injection:

- use a Design Library skill/contract or controlled task prompt variant that causes the first real runner attempt for the `implementer` or `checker` task to produce incomplete evidence, such as missing `commandsRun`, `testResults`, or `artifactEvidence`
- the callback must still come from the real runner path; do not insert a synthetic callback

Expected evidence:

- `before-recovery` checkpoint exists for the failed task
- `recovery_decision(selectedStrategy=retry-same-agent)` exists
- a new compact `context_packet` exists and references the Design Library compiled workflow/task
- the new `task_envelope.agentPrompt` matches the rebuilt context packet
- the failed suffix is summarized, not replayed in full
- callback is real
- final artifact is accepted
- complete evidence packet and validator results exist
- token telemetry is present
- Design Library gates still pass, including template validation from the recovered run

### E2E Case 2: Design Library real fork-from-checkpoint

Purpose: verify branch creation and preserved old branch in the Design Library todo-web workflow.

Failure injection:

- first branch takes a rejected product/design direction, for example implementing priority labels without due-date persistence or weakening checker/browser evidence requirements
- checker/evaluator rejects the branch because it fails the todo-web acceptance criteria or Design Library verification contract

Expected evidence:

- fork originates from the task-start or before-recovery checkpoint for the affected Design Library task
- new `session_node(parentSessionId, baseCheckpointId)` exists
- old branch remains inspectable and is not overwritten
- new compact recovery context includes Design Library template/version/task identity and accepted upstream artifact summaries
- real runner completes the new branch
- read model shows old and new branch lineage
- final branch artifact is accepted
- Design Library lifecycle evidence remains coherent: compiledFrom metadata, accepted artifacts, complete evidence, stop condition, and `template.validated_from_run`

### E2E Case 3: Design Library real rollback-workspace

Purpose: verify real git rollback and recovery dispatch on the todo-web fixture repo.

Failure injection:

- real runner modifies todo-web workspace incorrectly, for example breaking `src/todo-store.ts`, `src/app.ts`, or README/test alignment so Docker `npm test` or browser behavior verification fails
- git diff is non-empty before rollback

Expected evidence:

- workspace snapshot exists for the task
- rollback preview exists
- rollback is applied through real git operation
- `worktree_rollback` exists
- git diff returns to the expected pre-recovery state or to the approved rollback target
- recovery attempt is dispatched after rollback
- real callback is received
- Docker tests and todo-web browser behavior verification pass
- artifact is accepted
- Design Library gates still pass after recovery

## 12. Unit and Integration Test Coverage

Real E2E is required, but unit/integration tests are still necessary for fast feedback.

Unit tests:

- checkpoint payload validation
- recovery decision validation
- checkpoint cross-run rejection
- compact context rebuild includes required refs
- rebuilt context regenerates matching `agentPrompt`
- token telemetry calculation
- recovery strategy classifier

Integration tests:

- retry from invalid artifact creates recovery decision and new attempt
- fork from checkpoint creates new session node and preserves old branch
- reset supersedes old session
- rollback-workspace requires preview
- Pi-native unsupported path falls back to Southstar-native replay
- late callback from superseded branch does not mutate active branch

Read model tests:

- session tree shows branch lineage
- checkpoint timeline displays kind/task/session
- workflow canvas shows recovery edge
- token savings telemetry is visible
- stale branches are flagged

## 13. Acceptance Criteria

The design is complete when implementation demonstrates:

1. `before-recovery` checkpoints are created for all recovery actions.
2. Recovery actions are committed only by Southstar, not directly by LLM output.
3. `retry-same-agent`, `fork-from-checkpoint`, `reset-from-checkpoint`, `host-native-rewind`, and `rollback-workspace` have distinct semantics and audit records.
4. Southstar-native replay works without host-native capabilities.
5. Pi-native rewind/fork/resume is attempted only when capability and checkpoint anchors are safe.
6. Pi-native failure falls back to Southstar-native replay or records a blocked state.
7. Context rebuild creates immutable context packets and matching prompts.
8. Token telemetry is recorded for recovery attempts.
9. Read models expose checkpoints, branches, operations, and token telemetry.
10. Real E2E cases extend the Design Library real todo-web scenario and pass without fake adapters, mocked callbacks, smoke-only assertions, or calc scenarios.

## 14. Non-goals for v1

- Hard token-savings enforcement gates.
- Deleting branch history automatically.
- Full raw transcript persistence in checkpoints.
- Host-native support for every adapter.
- Cross-run checkpoint recovery.
- Replacing existing normal context refresh.

## 15. Implementation Notes

Likely areas to modify:

- `src/v2/session-graph/types.ts`
- `src/v2/session-graph/sqlite-provider.ts`
- `src/v2/ui-api/commands/session-memory-commands.ts`
- `src/v2/ui-api/commands/task-commands.ts`
- `src/v2/ui-api/commands/worktree-commands.ts`
- `src/v2/ui-api/local-api.ts`
- `src/v2/agent-runner/cli.ts`
- `src/v2/agent-runner/task-envelope.ts`
- `src/v2/context/builder.ts`
- `src/v2/executor/tork-callback.ts`
- `src/v2/read-models/sessions-memory.ts`
- `src/v2/ui-api/page-models/workflow-canvas.ts`
- `src/v2/ui-api/page-models/sessions-memory.ts`
- `tests/e2e-real/scenarios/design-library-template-real.ts`
- `tests/e2e-real/design-library-template-real.test.ts`
- `tests/e2e-real/scenarios/*`

The implementation should preserve current table structure and use `runtime_resources` plus `workflow_history` for new durable facts.
