# Northstar Controlled Recovery Workflow Design

## Goal

Design a controlled recovery architecture for Northstar where runtime exceptions can be diagnosed with LLM assistance without allowing the LLM to directly execute side effects, mutate lifecycle state, or bypass the deterministic state machine.

## Core Architecture Decision

Northstar recovery will follow these principles:

1. **Northstar core = deterministic state machine + policy executor**
2. **Recovery = workflow-driven diagnosis + action catalog**
3. **LLM = advisor/planner, not executor**
4. **Reconcile = the only decision entry point**

This design avoids the current pattern of growing ad-hoc orchestrator code for every new runtime exception while preserving auditability, replayability, and safety.

## Problem Statement

During real issue execution, failures can occur in many combinations of lifecycle state, workflow stage, blocker, adapter, host, and error code. Examples include dirty sync worktrees, existing branches, stale leases, lost child sessions, malformed artifacts, GitHub projection failures, and release sync drift.

The current deterministic recovery approach is safe, but it scales poorly if every new exception requires bespoke orchestrator code. At the same time, giving an LLM direct repair authority is unsafe because it could run shell commands, mutate the control-plane database, delete worktrees, dispatch duplicate workers, or release the wrong issue.

Northstar needs a middle path: LLM-assisted diagnosis with deterministic, policy-gated execution.

## Selected Design: Recovery Control Plane

Recovery becomes a controlled subsystem invoked by reconcile. It does not replace the lifecycle state machine. It detects blocked conditions, collects bounded evidence, matches deterministic recovery actions, optionally asks an LLM advisor for a proposal, validates the proposal through policy, executes only catalog-backed deterministic actions, records history, and then returns control to reconcile.

High-level flow:

```text
runtime error or blocked condition
  -> reconcile detects recovery trigger
  -> recovery evidence collector builds sanitized packet
  -> recovery catalog matcher searches deterministic actions
  -> if action found: policy check + dry-run + deterministic execute
  -> if no action found: LLM advisor proposes catalog action
  -> policy executor validates proposal
  -> deterministic executor performs side effect if allowed
  -> history is appended
  -> next reconcile cycle decides dispatch/release/wait/quarantine
```

Recovery never directly dispatches work, releases work, or decides a lifecycle transition beyond recording recovery facts. Reconcile remains the only component that decides the next workflow action.

## Recovery Action Catalog

The catalog is the authoritative allowlist of recovery capabilities. Each action is a deterministic executor with metadata that describes where it is allowed, what risk it carries, what inputs it accepts, and what preconditions must pass.

Conceptual interface:

```ts
interface RecoveryActionDefinition {
  id: string;
  description: string;
  match: {
    lifecycleStates: LifecycleState[];
    stages?: string[];
    blockers?: string[];
    errorCodes?: string[];
    domains?: string[];
  };
  risk: "safe" | "low" | "medium" | "high";
  inputSchema: Record<string, unknown>;
  preconditions: string[];
  effects: string[];
  dryRun(input: RecoveryActionInput): Promise<RecoveryDryRunResult>;
  execute(input: RecoveryActionInput): Promise<RecoveryExecutionResult>;
}
```

Example actions:

- `sync_worktree.reset_dirty`
  - Allowed when: `ready + sync_worktree + SYNC_WORKTREE_DIRTY`
  - Effect: reset and clean only the managed sync worktree, then fetch and fast-forward base
  - Risk: `low`

- `worktree.attach_existing_branch`
  - Allowed when: `ready + sync_worktree + WORKTREE_CREATE_FAILED`
  - Effect: attach an existing branch to the managed issue worktree path if it is not already attached elsewhere
  - Risk: `low`

- `owner_lease.release_expired`
  - Allowed when: active lifecycle state has expired owner lease
  - Effect: release stale active runtime ownership and record recovery facts
  - Risk: `safe` or `low`, depending on host liveness evidence

- `projection.retry_github_project`
  - Allowed when: projection failure is retryable and retry time has arrived
  - Effect: retry GitHub Project projection
  - Risk: `safe`

The catalog prevents LLM freeform action. If an action is not in the catalog, it cannot execute.

## Recovery Evidence Packet

The evidence packet is the bounded, sanitized context passed to deterministic matchers, policy, and optionally an LLM advisor. It must be stable, replayable, and safe to store in history.

Conceptual shape:

```ts
interface RecoveryEvidencePacket {
  issue: {
    id: string;
    number?: number;
    lifecycleState: LifecycleState;
    stage?: string;
    workflowId: string;
    domain?: string;
  };
  trigger: {
    source: "dispatch" | "reconcile" | "release" | "projection" | "host_liveness" | "artifact";
    blocker?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  runtime: {
    ownerLease?: Record<string, unknown>;
    childRuns: Array<Record<string, unknown>>;
    recentHistory: Array<Record<string, unknown>>;
    recoveryAttempts: number;
  };
  environment: {
    worktree?: Record<string, unknown>;
    branch?: Record<string, unknown>;
    github?: Record<string, unknown>;
    host?: Record<string, unknown>;
  };
  allowedActions: Array<{
    id: string;
    risk: string;
    summary: string;
    requiredInputs: string[];
  }>;
}
```

Evidence packets must redact secret-shaped values, avoid raw transcripts, avoid large logs, and include only evidence needed for recovery decision-making.

## LLM Advisor Contract

The LLM is an advisor. It receives the evidence packet and allowed action list. It returns a structured proposal artifact. It does not execute shell commands, write files, mutate the database, dispatch, release, merge, or push.

Conceptual artifact:

```ts
interface RecoveryProposalArtifact {
  schema_version: "1.0";
  artifact_kind: "recovery_proposal";
  classification: string;
  confidence: number;
  recommended_action?: {
    id: string;
    arguments: Record<string, unknown>;
  };
  risk_assessment: {
    risk: "safe" | "low" | "medium" | "high";
    operator_approval_required: boolean;
    reason: string;
  };
  evidence_used: string[];
  alternative_actions?: string[];
  no_action_reason?: string;
}
```

Northstar validates that the action exists in the catalog, arguments match schema, risk is not understated, confidence is above threshold, evidence references are valid, and policy permits execution.

## Policy Executor

The policy executor is the only component allowed to approve recovery side effects. It validates deterministic rule matches and LLM proposals using the same policy gate.

Policy rules:

- Unknown action id: reject and record `recovery_policy_rejected`.
- Unsupported state/stage/blocker/error code: reject and record `recovery_policy_rejected`.
- Invalid arguments: reject and record `recovery_policy_rejected`.
- Dry-run failure: reject or retry later depending on action metadata.
- `safe` and `low` risk actions may auto-execute if all preconditions pass and attempt budget remains.
- `medium` risk actions require operator approval by default.
- `high` risk actions never auto-execute.
- Recovery execution must be idempotent or guarded by idempotency keys.

The executor appends history before or during state updates according to existing Northstar persistence invariants. External side effects occur only through deterministic adapters.

## Runtime Context and History

No new lifecycle state is required for the first version. Recovery state is stored inside `runtime_context_json.recovery`.

Example:

```json
{
  "recovery": {
    "status": "executor_missing",
    "trigger_id": "ready:sync_worktree:WORKTREE_PATH_CONFLICT",
    "attempt": 1,
    "proposed_action": "worktree.rebind_existing_path",
    "last_policy_decision": "unsupported_action",
    "engineering_issue": {
      "id": "github:123",
      "status": "ready"
    }
  },
  "blocked_by": ["recovery_executor:worktree.rebind_existing_path"]
}
```

History event vocabulary:

- `recovery_triggered`
- `recovery_evidence_collected`
- `recovery_rule_matched`
- `recovery_advisor_requested`
- `recovery_proposal_received`
- `recovery_policy_accepted`
- `recovery_policy_rejected`
- `recovery_action_dry_run_passed`
- `recovery_action_executed`
- `recovery_action_failed`
- `recovery_cleared`
- `recovery_approval_required`
- `recovery_executor_request_created`

## Unsupported LLM Proposal Handling

If the LLM proposes an action with no catalog entry or no executor, Northstar does not execute it. The issue remains in its original lifecycle state with its blocker preserved or refined.

Northstar records:

```text
recovery_proposal_received
recovery_policy_rejected(reason=unsupported_action)
```

Then policy may create a recovery engineering issue if allowed.

## Recovery Engineering Issue Loop

When a missing executor blocks recovery, Northstar may create a normal GitHub engineering issue that implements the missing executor. This is the controlled self-improvement loop.

Flow:

```text
Original issue A encounters unsupported recovery action
  -> policy rejects unsupported action
  -> Northstar creates engineering issue B with dedupe key
  -> issue A is blocked_by recovery_executor:<action_id>
  -> issue B follows normal Northstar workflow
  -> issue B implements executor + tests + docs
  -> issue B reaches completed
  -> reconcile issue A again
  -> new executor is available
  -> recovery executes if policy permits
  -> issue A unblocks and returns to normal workflow
```

Engineering issue content must include:

- Original issue id and number
- Trigger signature: lifecycle, stage, blocker, error code
- Evidence packet id or sanitized summary
- LLM proposed action and reason
- Why the action is unsupported
- Required action id and allowed states
- Safety requirements
- Required tests
- Dedupe key

Safety guards:

- Same trigger/action can create only one open engineering issue.
- Recovery engineering depth is capped at 1 by default.
- If an engineering issue itself requires a missing executor, Northstar does not recursively create another executor issue automatically.
- High-risk executor requests require operator approval before issue creation.
- Completion of the engineering issue does not automatically execute high-risk recovery; policy still gates execution.

## Reconcile Integration

Reconcile remains the only decision entry point.

Suggested flow:

```text
1. Load snapshot.
2. Repair terminal/projection paths if applicable.
3. Reconcile external completion if applicable.
4. Detect active lease, host, artifact, release, or dispatch blockers.
5. If blocker exists, call recoveryController.reconcile(snapshot).
6. Recovery records facts and returns.
7. If no blocker remains, normal reconcile/runCycle decides start, finalize, verify, release, wait, or quarantine.
```

Recovery success clears the blocker or updates the relevant health facts. It does not call `startIssue`, `releaseIssue`, or directly move to a later lifecycle state.

## Non-Goals

- LLM freeform shell execution is not allowed.
- LLM direct database writes are not allowed.
- LLM direct lifecycle mutation is not allowed.
- Recovery does not replace workflow packages.
- Recovery does not add new lifecycle states in the first implementation.
- High-risk recovery does not auto-execute.

## Implementation Phases

### Phase 1: Catalog-first deterministic recovery

Extract existing hardcoded recovery paths into a recovery catalog and controller. No LLM integration in this phase.

Initial actions:

- `sync_worktree.reset_dirty`
- `worktree.attach_existing_branch`
- `owner_lease.release_expired`
- `projection.retry_github_project`
- `completed.sync_worktree_refresh`
- `verifier_artifact.recover_existing_pr`

Outcome: orchestrator stops accumulating one-off recovery branches and instead delegates to `recoveryController.reconcile(snapshot)`.

### Phase 2: Evidence packets and operator inspection

Add evidence packet generation and an inspect command such as:

```bash
northstar inspect-recovery --issue 69
```

Outcome: unknown failures produce actionable, sanitized evidence for humans even before LLM advisor integration.

### Phase 3: LLM advisor in proposal-only mode

Add LLM advisor support that emits `recovery_proposal` artifacts but does not execute them automatically.

Outcome: Northstar can record suggested actions and policy decisions without side effects.

### Phase 4: Policy-gated automatic recovery

Allow `safe` and selected `low` risk catalog actions to auto-execute after dry-run and policy approval. Medium and high risk actions require operator approval.

Outcome: frequent low-risk recovery becomes automatic while unknown or risky cases remain controlled.

### Phase 5: Recovery engineering issue loop

When no executor exists, create deduplicated recovery engineering issues that follow the normal Northstar workflow.

Outcome: Northstar can safely expand its recovery capabilities through normal reviewed implementation paths instead of runtime self-modification.

## Success Criteria

- Reconcile remains the only entry point that decides workflow progression.
- LLM cannot execute side effects or mutate lifecycle state.
- Every recovery side effect is backed by a catalog action, schema, preconditions, dry-run, and history events.
- Unsupported LLM proposals are rejected and auditable.
- Missing executors can be converted into normal engineering issues with dedupe and recursion guards.
- Existing recovery cases continue to pass tests after extraction into the catalog.
- Unknown recovery cases produce evidence packets instead of opaque failures.

## Recommended First Implementation Slice

Start with Phase 1 and a small part of Phase 2:

1. Create `src/recovery/catalog.ts` for action metadata and matching.
2. Create `src/recovery/controller.ts` for policy-gated recovery orchestration.
3. Create `src/recovery/evidence.ts` for bounded evidence packets.
4. Move current sync worktree and branch/worktree recovery into catalog actions.
5. Wire `createProductionOrchestrator` to call recovery controller from reconcile/runCycle.
6. Add tests proving recovery clears blockers but does not dispatch directly.
7. Add tests proving unsupported actions are rejected and leave the original issue blocked.

This slice reduces orchestrator growth immediately while preserving deterministic behavior. LLM advisor and engineering issue creation can be added after the catalog boundary is stable.
