import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  executeBestEffortCancelAction,
  requestedCancelAction,
  type RecoveryProviderActions,
} from "../executor/provider-actions.ts";
import type { HandProvider } from "../hands/types.ts";
import { createPostgresRecoveryController } from "../session-recovery/postgres-controller.ts";
import { applySessionRecoveryOperationPg } from "../session-recovery/session-operations.ts";
import { createPostgresSessionStore } from "../session/postgres-session-store.ts";
import type { SessionStore } from "../session/types.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import { resolveRuntimeExceptionPg } from "./postgres-runtime-exceptions.ts";
import {
  completeRecoveryExecutionPg,
  recoveryExecutionResourceKey,
  startRecoveryExecutionPg,
} from "./recovery-executions.ts";
import {
  RECOVERY_EXECUTION_RESOURCE_TYPE,
  RECOVERY_DECISION_RESOURCE_TYPE,
  RECOVERY_DECISION_SCHEMA_VERSION,
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
  type RecoveryDecisionPayload,
  type RecoveryDecisionStatus,
  type RecoveryExecutionPayload,
  type RecoveryExecutionProviderAction,
  type RecoveryExecutionStateChange,
  type RuntimeRecoveryDecisionRecord,
} from "./types.ts";

export type RecoveryDecisionApplyResult = {
  status: "applied" | "skipped" | "blocked" | "failed" | "superseded";
  executionResourceKey?: string;
  reason: string;
};

type RecoveryDecisionApplyResultWithCancel = RecoveryDecisionApplyResult & {
  cancelExecution?: ProviderCancelExecution;
};

type RuntimeResourceRow = {
  id: string;
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  metrics_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
};

type RequeueMutationResult = {
  stateChanges: RecoveryExecutionStateChange[];
  providerActions: RecoveryExecutionProviderAction[];
  exceptionResourceKey: string;
};

type RecoveryExecutionEvidence = Pick<RequeueMutationResult, "stateChanges" | "providerActions">;

type StagedRecoveryExecutionEvidence = {
  evidence: RecoveryExecutionEvidence;
  staged: boolean;
};

type ProviderCancelExecution = {
  providerId: string;
  externalJobId: string;
  runId: string;
  evidenceRef?: string;
  reason: string;
};

type PreparedRecoveryExecutionEvidence = StagedRecoveryExecutionEvidence & {
  cancelExecution?: ProviderCancelExecution;
};

type RecoveryDecisionApplierDeps = {
  db: SouthstarDb;
  sessionStore?: SessionStore;
  brainProvider?: BrainProvider;
  handProvider?: HandProvider;
  providerActions?: RecoveryProviderActions;
};

type ManagedRecoveryDecisionApplierDeps = RecoveryDecisionApplierDeps & {
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
};

type ReprovisionRecoveryContext = {
  task: { status: string };
  hand: RuntimeResourceRecord;
  exception: RuntimeResourceRecord;
  oldHandBinding: RuntimeResourceRecord | null;
  sessionId: string;
};

type SimpleRecoveryContext = {
  task: { status: string } | null;
  run: { status: string };
  exception: RuntimeResourceRecord;
  hand: RuntimeResourceRecord | null;
  sessionId?: string;
};

export function createRecoveryDecisionApplier(deps: RecoveryDecisionApplierDeps): {
  applyNext(input?: { runId?: string; now?: string }): Promise<RecoveryDecisionApplyResult | null>;
  applyDecision(input: { decisionResourceKey: string; now?: string }): Promise<RecoveryDecisionApplyResult>;
} {
  return {
    async applyNext(input = {}) {
      const row = await deps.db.maybeOne<{ resource_key: string }>(
        `select resource_key
           from southstar.runtime_resources
          where resource_type = $1
            and payload_json->>'schemaVersion' = $2
            and status in ('recorded', 'approved', 'applying')
            and ($3::text is null or run_id = $3)
          order by created_at, resource_key
          limit 1`,
        [RECOVERY_DECISION_RESOURCE_TYPE, RECOVERY_DECISION_SCHEMA_VERSION, input.runId ?? null],
      );
      if (!row) return null;
      return await this.applyDecision({ decisionResourceKey: row.resource_key, now: input.now });
    },
    async applyDecision(input) {
      const now = input.now ?? new Date().toISOString();
      const decision = requireRecoveryDecision(
        await getResourceByKeyPg(deps.db, RECOVERY_DECISION_RESOURCE_TYPE, input.decisionResourceKey),
      );
      const executionResourceKey = recoveryExecutionResourceKey(decision.decisionId);

      if (decision.status === "applied") {
        return { status: "applied", executionResourceKey, reason: "decision already applied" };
      }
      if (decision.status === "waiting_operator_approval") {
        return { status: "skipped", reason: "decision waiting for operator approval" };
      }
      if (decision.status === "blocked" || decision.status === "failed" || decision.status === "superseded") {
        const repairedExecutionResourceKey = await repairTerminalRecoveryExecutionPg(deps.db, {
          decision,
          executionResourceKey,
          now,
        });
        return {
          status: decision.status,
          ...(repairedExecutionResourceKey ? { executionResourceKey: repairedExecutionResourceKey } : {}),
          reason: terminalDecisionReason(decision),
        };
      }

      const claimedDecision = await claimRecoveryDecisionApplyingPg(deps.db, { decision, now });
      if (claimedDecision.status === "applied") {
        return { status: "applied", executionResourceKey, reason: "decision already applied" };
      }
      if (claimedDecision.status === "waiting_operator_approval") {
        return { status: "skipped", reason: "decision waiting for operator approval" };
      }
      if (claimedDecision.status === "blocked" || claimedDecision.status === "failed" || claimedDecision.status === "superseded") {
        const repairedExecutionResourceKey = await repairTerminalRecoveryExecutionPg(deps.db, {
          decision: claimedDecision,
          executionResourceKey,
          now,
        });
        return {
          status: claimedDecision.status,
          ...(repairedExecutionResourceKey ? { executionResourceKey: repairedExecutionResourceKey } : {}),
          reason: terminalDecisionReason(claimedDecision),
        };
      }
      const applyingDecision: RuntimeRecoveryDecisionRecord = { ...claimedDecision, status: "applying" };

      const started = await startRecoveryExecutionPg(deps.db, {
        decisionId: applyingDecision.decisionId,
        exceptionId: applyingDecision.payload.exceptionId,
        runId: applyingDecision.payload.runId,
        taskId: applyingDecision.payload.taskId,
        path: applyingDecision.payload.path,
        now,
      });

      if (started.status !== "started") {
        if (started.status === "succeeded") {
          return await finalizeRecoveryDecisionAppliedPg(deps.db, { decision: applyingDecision, executionResourceKey: started.resourceKey, now });
        }
        return { status: started.status, executionResourceKey: started.resourceKey, reason: `recovery execution already ${started.status}` };
      }

      const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(deps.db, {
        decision: applyingDecision,
        executionResourceKey: started.resourceKey,
        now,
      });
      if (completedTaskPrecondition) return completedTaskPrecondition;

      if (applyingDecision.payload.path === "wake-new-brain") {
        const missingDeps = missingWakeNewBrainDeps(deps);
        if (missingDeps.length > 0) {
          const reason = `missing wake-new-brain dependencies: ${missingDeps.join(", ")}`;
          const terminalDecision = await blockDecision(deps.db, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
            reason,
          });
          return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
        }

        try {
          return await applyWakeNewBrainMutation(deps as ManagedRecoveryDecisionApplierDeps, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
          });
        } catch (error) {
          if (error instanceof Error && isWakeNewBrainBlockableError(error.message, applyingDecision)) {
            const terminalDecision = await blockDecision(deps.db, {
              decision: applyingDecision,
              executionResourceKey: started.resourceKey,
              now,
              reason: error.message,
            });
            return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
          }
          throw error;
        }
      }

      if (applyingDecision.payload.path === "reprovision-hand") {
        const missingFieldReason = missingTaskOrHandReason(applyingDecision);
        if (missingFieldReason) {
          const terminalDecision = await blockDecision(deps.db, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
            reason: missingFieldReason,
          });
          return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
        }
        const missingDeps = missingReprovisionDeps(deps);
        if (missingDeps.length > 0) {
          const reason = `missing reprovision-hand dependencies: ${missingDeps.join(", ")}`;
          const terminalDecision = await blockDecision(deps.db, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
            reason,
          });
          return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
        }

        try {
          const result = await applyReprovisionMutation(deps as ManagedRecoveryDecisionApplierDeps, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
          });
          const { cancelExecution, ...applyResult } = result;
          if (cancelExecution) {
            await executeAndUpdateStagedCancelActionPg(deps.db, {
              executionResourceKey: started.resourceKey,
              cancelExecution,
              now,
              providerActions: deps.providerActions,
            });
          }
          return applyResult;
        } catch (error) {
          if (error instanceof Error && isReprovisionBlockableError(error.message, applyingDecision)) {
            const terminalDecision = await blockDecision(deps.db, {
              decision: applyingDecision,
              executionResourceKey: started.resourceKey,
              now,
              reason: error.message,
            });
            return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
          }
          throw error;
        }
      }

      if (isSimpleRecoveryPath(applyingDecision.payload.path)) {
        try {
          return await applySimpleRecoveryMutation(deps.db, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
          });
        } catch (error) {
          if (error instanceof Error && isSimpleRecoveryBlockableError(error.message, applyingDecision)) {
            const terminalDecision = await blockDecision(deps.db, {
              decision: applyingDecision,
              executionResourceKey: started.resourceKey,
              now,
              reason: error.message,
            });
            return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
          }
          throw error;
        }
      }

      if (isSessionRecoveryPath(applyingDecision.payload.path)) {
        try {
          return await applySessionRecoveryMutation(deps.db, {
            decision: applyingDecision,
            decisionWasApproved: decision.status === "approved",
            executionResourceKey: started.resourceKey,
            now,
          });
        } catch (error) {
          if (error instanceof Error && isSessionRecoveryBlockableError(error.message, applyingDecision)) {
            const terminalDecision = await blockDecision(deps.db, {
              decision: applyingDecision,
              executionResourceKey: started.resourceKey,
              now,
              reason: error.message,
            });
            return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
          }
          throw error;
        }
      }

      if (applyingDecision.payload.path !== "requeue-hand-execution") {
        const terminalDecision = await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: `unsupported recovery path ${applyingDecision.payload.path}`,
        });
        return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
      }

      const missingFieldReason = missingTaskOrHandReason(applyingDecision);
      if (missingFieldReason) {
        const terminalDecision = await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: missingFieldReason,
        });
        return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
      }

      let mutation: RequeueMutationResult | RecoveryDecisionApplyResult;
      try {
        const preparedEvidence = await stageRequeueRecoveryEvidencePg(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          providerActions: deps.providerActions,
        });
        if ("status" in preparedEvidence) return preparedEvidence;
        const stagedEvidence = preparedEvidence.cancelExecution
          ? await executeAndUpdateStagedCancelActionPg(deps.db, {
            executionResourceKey: started.resourceKey,
            cancelExecution: preparedEvidence.cancelExecution,
            now,
            providerActions: deps.providerActions,
          })
          : preparedEvidence.evidence;
        mutation = await applyRequeueMutation(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          stagedEvidence,
        });
      } catch (error) {
        if (error instanceof Error && error.message === `hand execution ${applyingDecision.payload.handExecutionId} not found`) {
          const terminalDecision = await blockDecision(deps.db, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
            reason: error.message,
          });
          return terminalDecisionApplyResult(terminalDecision, started.resourceKey);
        }
        throw error;
      }
      if ("status" in mutation) return mutation;
      await resolveRuntimeExceptionPg(deps.db, {
        runId: applyingDecision.payload.runId,
        resourceKey: mutation.exceptionResourceKey,
        resolvedAt: now,
        reason: "requeue-hand-execution applied",
      });

      await completeRecoveryExecutionPg(deps.db, {
        runId: applyingDecision.payload.runId,
        executionResourceKey: started.resourceKey,
        status: "succeeded",
        completedAt: requeueTerminalAt(mutation.providerActions) ?? now,
        stateChanges: mutation.stateChanges,
        providerActions: mutation.providerActions,
      });
      return await finalizeRecoveryDecisionAppliedPg(deps.db, { decision: applyingDecision, executionResourceKey: started.resourceKey, now });
    },
  };
}

async function applyCompletedTaskPreconditionPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<RecoveryDecisionApplyResult | null> {
  const taskId = input.decision.payload.taskId;
  if (!taskId) return null;

  const task = await db.maybeOne<{ status: string }>(
    "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
    [input.decision.payload.runId, taskId],
  );
  if (task?.status !== "completed") return null;

  const acceptedArtifact = await db.maybeOne<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where resource_type = 'artifact_ref'
        and run_id = $1
        and task_id = $2
        and status = 'accepted'
      order by created_at, resource_key
      limit 1`,
    [input.decision.payload.runId, taskId],
  );

  if (!acceptedArtifact) {
    const reason = "completed task is missing accepted artifact_ref for recovery decision task";
    const terminalDecision = await blockDecision(db, {
      decision: input.decision,
      executionResourceKey: input.executionResourceKey,
      now: input.now,
      reason,
    });
    return terminalDecisionApplyResult(terminalDecision, input.executionResourceKey);
  }

  const reason = "completed task has accepted artifact_ref for recovery decision task";
  const terminalDecision = await supersedeDecision(db, {
    decision: input.decision,
    executionResourceKey: input.executionResourceKey,
    now: input.now,
    reason,
  });
  return terminalDecisionApplyResult(terminalDecision, input.executionResourceKey);
}

async function stageRequeueRecoveryEvidencePg(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    providerActions?: RecoveryProviderActions;
  },
): Promise<PreparedRecoveryExecutionEvidence | RecoveryDecisionApplyResult> {
  return await db.tx(async (tx) => {
    const { decision, now } = input;
    const taskId = requireString(decision.payload.taskId, "taskId");
    const handExecutionId = requireString(decision.payload.handExecutionId, "handExecutionId");

    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
    const task = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [decision.payload.runId, taskId],
    );
    if (!task) throw new Error(`workflow task ${taskId} does not belong to run ${decision.payload.runId}`);
    const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(tx, {
      decision,
      executionResourceKey: input.executionResourceKey,
      now,
    });
    if (completedTaskPrecondition) return completedTaskPrecondition;

    const hand = mapRuntimeResourceRow(await tx.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = 'hand_execution'
          and resource_key = $1
        for update`,
      [handExecutionId],
    ));
    if (!hand) throw new Error(`hand execution ${handExecutionId} not found`);

    const exception = mapRuntimeResourceRow(await tx.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = $1
          and run_id = $2
          and payload_json->>'exceptionId' = $3
        for update`,
      [RUNTIME_EXCEPTION_RESOURCE_TYPE, decision.payload.runId, decision.payload.exceptionId],
    ));
    if (!exception) throw new Error(`runtime exception ${decision.payload.exceptionId} not found`);

    const handPayload = isPlainObject(hand.payload) ? hand.payload : {};
    const providerId = typeof handPayload.providerId === "string" ? handPayload.providerId : "tork";
    const externalJobId = stringValue(handPayload.externalJobId);
    const cancelAction = requestedCancelAction({
      providerActions: input.providerActions,
      providerId,
      externalJobId,
      evidenceRef: hand.resourceKey,
      now,
    });
    const staged = await stageRecoveryExecutionEvidenceWithStatusPg(tx, {
      executionResourceKey: input.executionResourceKey,
      evidence: requeueRecoveryExecutionEvidence({ decision, task, hand, exception, cancelAction }),
      now,
    });

    return {
      ...staged,
      ...(staged.staged && cancelAction.status === "requested" && externalJobId
        ? {
          cancelExecution: {
            providerId,
            externalJobId,
            runId: decision.payload.runId,
            evidenceRef: hand.resourceKey,
            reason: "requeue-hand-execution",
          },
        }
        : {}),
    };
  });
}

async function executeAndUpdateStagedCancelActionPg(
  db: SouthstarDb,
  input: {
    executionResourceKey: string;
    cancelExecution: ProviderCancelExecution;
    now: string;
    providerActions?: RecoveryProviderActions;
  },
): Promise<RecoveryExecutionEvidence> {
  if (!input.providerActions?.cancel) {
    return await loadLatestStagedRecoveryExecutionEvidencePg(db, input.executionResourceKey);
  }

  const result = await executeBestEffortCancelAction({
    providerActions: input.providerActions,
    providerId: input.cancelExecution.providerId,
    externalJobId: input.cancelExecution.externalJobId,
    runId: input.cancelExecution.runId,
    evidenceRef: input.cancelExecution.evidenceRef,
    reason: input.cancelExecution.reason,
    now: input.now,
  });
  return await updateStagedCancelActionResultPg(db, {
    executionResourceKey: input.executionResourceKey,
    result,
    now: input.now,
  });
}

async function updateStagedCancelActionResultPg(
  db: SouthstarDb,
  input: { executionResourceKey: string; result: RecoveryExecutionProviderAction; now: string },
): Promise<RecoveryExecutionEvidence> {
  return await db.tx(async (tx) => {
    const execution = await lockRecoveryExecutionForUpdatePg(tx, input.executionResourceKey);
    if (execution.status !== "started" && execution.status !== "succeeded") {
      throw new Error(`recovery execution ${input.executionResourceKey} is ${execution.status}, expected started or succeeded`);
    }

    const payload = execution.payload as RecoveryExecutionPayload;
    const existingEvidence = stagedRecoveryExecutionEvidence(payload);
    if (!existingEvidence) {
      throw new Error(`recovery execution ${input.executionResourceKey} has no staged evidence`);
    }

    const providerActions = existingEvidence.providerActions.map((action) => {
      if (action.action !== "cancel" || action.status !== "requested") return action;
      if (action.evidenceRef !== input.result.evidenceRef) return action;
      return input.result;
    });

    await upsertRuntimeResourcePg(tx, {
      id: execution.id,
      resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
      resourceKey: execution.resourceKey,
      runId: execution.runId,
      taskId: execution.taskId,
      sessionId: execution.sessionId,
      scope: execution.scope,
      status: execution.status,
      title: execution.title,
      payload: {
        ...payload,
        providerActions,
      },
      summary: {
        ...(isPlainObject(execution.summary) ? execution.summary : {}),
        evidenceUpdatedAt: input.now,
      },
      metrics: execution.metrics,
      expiresAt: execution.expiresAt,
    });

    return {
      stateChanges: existingEvidence.stateChanges,
      providerActions,
    };
  });
}

async function loadLatestStagedRecoveryExecutionEvidencePg(
  db: SouthstarDb,
  executionResourceKey: string,
): Promise<RecoveryExecutionEvidence> {
  const execution = await getResourceByKeyPg(db, RECOVERY_EXECUTION_RESOURCE_TYPE, executionResourceKey);
  if (!execution) throw new Error(`recovery execution ${executionResourceKey} not found`);
  const evidence = stagedRecoveryExecutionEvidence(execution.payload as RecoveryExecutionPayload);
  if (!evidence) throw new Error(`recovery execution ${executionResourceKey} has no staged evidence`);
  return evidence;
}

async function applyRequeueMutation(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    stagedEvidence: RecoveryExecutionEvidence | null;
  },
): Promise<RequeueMutationResult | RecoveryDecisionApplyResult> {
  return await db.tx(async (tx) => {
    const { decision, now } = input;
    const taskId = requireString(decision.payload.taskId, "taskId");
    const handExecutionId = requireString(decision.payload.handExecutionId, "handExecutionId");

    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
    const task = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [decision.payload.runId, taskId],
    );
    if (!task) throw new Error(`workflow task ${taskId} does not belong to run ${decision.payload.runId}`);
    const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(tx, {
      decision,
      executionResourceKey: input.executionResourceKey,
      now,
    });
    if (completedTaskPrecondition) return completedTaskPrecondition;

    const hand = mapRuntimeResourceRow(await tx.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = 'hand_execution'
          and resource_key = $1
        for update`,
      [handExecutionId],
    ));
    if (!hand) {
      throw new Error(`hand execution ${handExecutionId} not found`);
    }

    const exception = mapRuntimeResourceRow(await tx.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = $1
          and run_id = $2
          and payload_json->>'exceptionId' = $3
        for update`,
      [RUNTIME_EXCEPTION_RESOURCE_TYPE, decision.payload.runId, decision.payload.exceptionId],
    ));
    if (!exception) throw new Error(`runtime exception ${decision.payload.exceptionId} not found`);

    const handPayload = hand.payload as Record<string, unknown>;
    const providerId = typeof handPayload.providerId === "string" ? handPayload.providerId : "tork";
    let evidence = input.stagedEvidence;
    if (!evidence) {
      const cancelAction = requestedCancelAction({
        providerId,
        externalJobId: stringValue(handPayload.externalJobId),
        evidenceRef: hand.resourceKey,
        now,
      });
      const recomputedEvidence = requeueRecoveryExecutionEvidence({ decision, task, hand, exception, cancelAction });
      evidence = await stageRecoveryExecutionEvidencePg(tx, {
        executionResourceKey: input.executionResourceKey,
        evidence: recomputedEvidence,
        now,
      });
    }
    const terminalAt = requeueTerminalAt(evidence.providerActions) ?? now;
    await upsertRuntimeResourcePg(tx, {
      id: hand.id,
      resourceType: "hand_execution",
      resourceKey: hand.resourceKey,
      runId: hand.runId,
      taskId: hand.taskId,
      sessionId: hand.sessionId,
      scope: hand.scope,
      status: "lost",
      title: hand.title,
      payload: {
        ...handPayload,
        status: "lost",
        terminalAt,
        lostReason: "requeue-hand-execution",
        recoveryDecisionId: decision.decisionId,
      },
      summary: hand.summary,
      metrics: hand.metrics,
      expiresAt: hand.expiresAt,
    });

    await tx.query(
      "update southstar.workflow_tasks set status = 'pending', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
      [decision.payload.runId, taskId],
    );

    return {
      exceptionResourceKey: exception.resourceKey,
      providerActions: evidence.providerActions,
      stateChanges: evidence.stateChanges,
    };
  });
}

async function applySimpleRecoveryMutation(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
  },
): Promise<RecoveryDecisionApplyResult> {
  const { decision, now } = input;
  return await db.tx(async (tx) => {
    const execution = await lockRecoveryExecutionForUpdatePg(tx, input.executionResourceKey);
    if (execution.status !== "started") {
      if (execution.status === "succeeded") {
        return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: execution.resourceKey, now });
      }
      return {
        status: execution.status,
        executionResourceKey: execution.resourceKey,
        reason: `recovery execution already ${execution.status}`,
      };
    }

    const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(tx, {
      decision,
      executionResourceKey: input.executionResourceKey,
      now,
    });
    if (completedTaskPrecondition) return completedTaskPrecondition;

    const context = await loadSimpleRecoveryContext(tx, decision);
    const currentEvidence = stagedRecoveryExecutionEvidence(execution.payload as RecoveryExecutionPayload);
    const evidence = currentEvidence ?? await stageRecoveryExecutionEvidencePg(tx, {
      executionResourceKey: input.executionResourceKey,
      evidence: simpleRecoveryExecutionEvidence({ decision, context }),
      now,
    });

    const path = decision.payload.path;
    const taskId = decision.payload.taskId;
    if ((path === "retry-same-task-new-attempt" || path === "repair-artifact" || path === "block-for-operator" || path === "fail-task") && !taskId) {
      throw new Error(`${path} decision missing taskId`);
    }

    if (path === "retry-same-task-new-attempt" && context.hand) {
      const handPayload = isPlainObject(context.hand.payload) ? context.hand.payload : {};
      await upsertRuntimeResourcePg(tx, {
        id: context.hand.id,
        resourceType: "hand_execution",
        resourceKey: context.hand.resourceKey,
        runId: context.hand.runId,
        taskId: context.hand.taskId,
        sessionId: context.hand.sessionId,
        scope: context.hand.scope,
        status: "superseded",
        title: context.hand.title,
        payload: {
          ...handPayload,
          status: "superseded",
          terminalAt: simpleRecoveryTerminalAt(evidence, execution.payload as RecoveryExecutionPayload, now),
          supersededReason: path,
          recoveryDecisionId: decision.decisionId,
        },
        summary: context.hand.summary,
        metrics: context.hand.metrics,
        expiresAt: context.hand.expiresAt,
      });
    }

    if (path === "retry-same-task-new-attempt" || path === "repair-artifact") {
      await tx.query(
        "update southstar.workflow_tasks set status = 'pending', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
        [decision.payload.runId, taskId],
      );
    } else if (path === "block-for-operator") {
      await tx.query(
        "update southstar.workflow_tasks set status = 'blocked', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
        [decision.payload.runId, taskId],
      );
    } else if (path === "fail-task") {
      await tx.query(
        "update southstar.workflow_tasks set status = 'failed', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
        [decision.payload.runId, taskId],
      );
    } else if (path === "fail-run") {
      await tx.query(
        "update southstar.workflow_runs set status = 'failed', completed_at = null, updated_at = now() where id = $1",
        [decision.payload.runId],
      );
    }

    if (path !== "block-for-operator") {
      await resolveRuntimeExceptionPg(tx, {
        runId: decision.payload.runId,
        resourceKey: context.exception.resourceKey,
        resolvedAt: now,
        reason: `${path} applied`,
      });
      await completeRecoveryExecutionPg(tx, {
        runId: decision.payload.runId,
        executionResourceKey: input.executionResourceKey,
        status: "succeeded",
        completedAt: simpleRecoveryTerminalAt(evidence, execution.payload as RecoveryExecutionPayload, now),
        stateChanges: evidence.stateChanges,
        providerActions: evidence.providerActions,
      });
      return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: input.executionResourceKey, now });
    }

    const blockedDecision = await writeTerminalDecisionPg(tx, {
      decision,
      now,
      reason: "block-for-operator blocked",
      status: "blocked",
      terminalAtField: "blockedAt",
    });
    await completeRecoveryExecutionPg(tx, {
      runId: decision.payload.runId,
      executionResourceKey: input.executionResourceKey,
      status: "blocked",
      completedAt: simpleRecoveryTerminalAt(evidence, execution.payload as RecoveryExecutionPayload, now),
      stateChanges: evidence.stateChanges,
      providerActions: evidence.providerActions,
    });
    return terminalDecisionApplyResult(blockedDecision, input.executionResourceKey);
  });
}

async function applyWakeNewBrainMutation(
  deps: ManagedRecoveryDecisionApplierDeps,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
  },
): Promise<RecoveryDecisionApplyResult> {
  const { decision, now } = input;
  const taskId = requireDecisionString(decision.payload.taskId, decision.payload.path, "taskId");

  return await deps.db.tx(async (tx) => {
    const execution = await lockRecoveryExecutionForUpdatePg(tx, input.executionResourceKey);
    if (execution.status !== "started") {
      if (execution.status === "succeeded") {
        return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: execution.resourceKey, now });
      }
      return {
        status: execution.status,
        executionResourceKey: execution.resourceKey,
        reason: `recovery execution already ${execution.status}`,
      };
    }

    const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(tx, {
      decision,
      executionResourceKey: input.executionResourceKey,
      now,
    });
    if (completedTaskPrecondition) return completedTaskPrecondition;

    const context = await loadSimpleRecoveryContext(tx, decision);
    const sessionId = context.sessionId;
    if (!sessionId) throw new Error("wake-new-brain decision missing sessionId");

    const currentEvidence = stagedRecoveryExecutionEvidence(execution.payload as RecoveryExecutionPayload);
    const evidence = currentEvidence ?? await performAndStageWakeNewBrainRecovery(tx, deps, {
      decision,
      taskId,
      sessionId,
      context,
      executionResourceKey: input.executionResourceKey,
      now,
    });

    await tx.query(
      "update southstar.workflow_tasks set status = 'pending', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
      [decision.payload.runId, taskId],
    );

    await resolveRuntimeExceptionPg(tx, {
      runId: decision.payload.runId,
      resourceKey: context.exception.resourceKey,
      resolvedAt: now,
      reason: "wake-new-brain applied",
    });

    await completeRecoveryExecutionPg(tx, {
      runId: decision.payload.runId,
      executionResourceKey: input.executionResourceKey,
      status: "succeeded",
      completedAt: recoveryActionTerminalAt(evidence.providerActions, "wake") ?? simpleRecoveryTerminalAt(evidence, execution.payload as RecoveryExecutionPayload, now),
      stateChanges: evidence.stateChanges,
      providerActions: evidence.providerActions,
    });
    return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: input.executionResourceKey, now });
  });
}

async function applySessionRecoveryMutation(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    decisionWasApproved: boolean;
    executionResourceKey: string;
    now: string;
  },
): Promise<RecoveryDecisionApplyResult> {
  const { decision, now } = input;
  const taskId = requireDecisionString(decision.payload.taskId, decision.payload.path, "taskId");

  return await db.tx(async (tx) => {
    const execution = await lockRecoveryExecutionForUpdatePg(tx, input.executionResourceKey);
    if (execution.status !== "started") {
      if (execution.status === "succeeded") {
        return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: execution.resourceKey, now });
      }
      return {
        status: execution.status,
        executionResourceKey: execution.resourceKey,
        reason: `recovery execution already ${execution.status}`,
      };
    }

    const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(tx, {
      decision,
      executionResourceKey: input.executionResourceKey,
      now,
    });
    if (completedTaskPrecondition) return completedTaskPrecondition;

    const context = await loadSimpleRecoveryContext(tx, decision);
    const currentEvidence = stagedRecoveryExecutionEvidence(execution.payload as RecoveryExecutionPayload);
    const evidence = currentEvidence ?? await performAndStageSessionRecovery(tx, {
      decision,
      taskId,
      decisionWasApproved: input.decisionWasApproved,
      executionResourceKey: input.executionResourceKey,
      now,
    });

    await resolveRuntimeExceptionPg(tx, {
      runId: decision.payload.runId,
      resourceKey: context.exception.resourceKey,
      resolvedAt: now,
      reason: `${decision.payload.path} applied`,
    });

    await completeRecoveryExecutionPg(tx, {
      runId: decision.payload.runId,
      executionResourceKey: input.executionResourceKey,
      status: "succeeded",
      completedAt: now,
      stateChanges: [
        ...evidence.stateChanges,
        {
          resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
          resourceKey: decision.resourceKey,
          fromStatus: "applying",
          toStatus: "applied",
          reason: `${decision.payload.path} applied`,
        },
        {
          resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
          resourceKey: context.exception.resourceKey,
          fromStatus: context.exception.status,
          toStatus: "resolved",
          reason: `${decision.payload.path} applied`,
        },
      ],
      providerActions: evidence.providerActions,
    });
    return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: input.executionResourceKey, now });
  });
}

async function performAndStageSessionRecovery(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    taskId: string;
    decisionWasApproved: boolean;
    executionResourceKey: string;
    now: string;
  },
): Promise<RecoveryExecutionEvidence> {
  const payload = input.decision.payload as RecoveryDecisionPayload & Record<string, unknown>;
  const operatorDecision = typeof payload.operatorDecision === "string" ? payload.operatorDecision : undefined;
  const approved = input.decision.payload.path === "rollback-session"
    ? input.decisionWasApproved || operatorDecision === "approved"
    : true;
  const result = await applySessionRecoveryOperationPg(db, {
    operationId: input.decision.decisionId,
    runId: input.decision.payload.runId,
    taskId: input.taskId,
    path: input.decision.payload.path as "fork-session" | "reset-session" | "rollback-session",
    approved,
    checkpointId: stringValue(payload.checkpointId) ?? firstEvidenceRef(input.decision.payload.evidenceRefs, /^session_checkpoint:|^checkpoint[-:]/),
    workspaceSnapshotRef: stringValue(payload.workspaceSnapshotRef) ?? firstEvidenceRef(input.decision.payload.evidenceRefs, /^workspace[_-]snapshot:/),
    invalidatedSourceRefs: arrayOfStrings(payload.invalidatedSourceRefs),
    reason: input.decision.payload.reason,
    now: input.now,
  });
  if (result.status !== "succeeded") {
    throw new Error(`${input.decision.payload.path} requires operator approval`);
  }
  return await stageRecoveryExecutionEvidencePg(db, {
    executionResourceKey: input.executionResourceKey,
    evidence: {
      stateChanges: result.stateChanges,
      providerActions: result.providerActions,
    },
    now: input.now,
  });
}

async function applyReprovisionMutation(
  deps: ManagedRecoveryDecisionApplierDeps,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
  },
): Promise<RecoveryDecisionApplyResultWithCancel> {
  const { decision, now } = input;
  const taskId = requireDecisionString(decision.payload.taskId, decision.payload.path, "taskId");
  const handExecutionId = requireDecisionString(decision.payload.handExecutionId, decision.payload.path, "handExecutionId");

  return await deps.db.tx(async (tx) => {
    const execution = await lockRecoveryExecutionForUpdatePg(tx, input.executionResourceKey);
    if (execution.status !== "started") {
      if (execution.status === "succeeded") {
        return await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: execution.resourceKey, now });
      }
      if (execution.status === "blocked" || execution.status === "failed" || execution.status === "superseded") {
        return {
          status: execution.status,
          executionResourceKey: execution.resourceKey,
          reason: `recovery execution already ${execution.status}`,
        };
      }
      throw new Error(`recovery execution ${execution.resourceKey} is ${execution.status}, expected started`);
    }

    const completedTaskPrecondition = await applyCompletedTaskPreconditionPg(tx, {
      decision,
      executionResourceKey: input.executionResourceKey,
      now,
    });
    if (completedTaskPrecondition) return completedTaskPrecondition;

    const currentEvidence = stagedRecoveryExecutionEvidence(execution.payload as RecoveryExecutionPayload);
    const preparedEvidence: PreparedRecoveryExecutionEvidence = currentEvidence
      ? { evidence: currentEvidence, staged: false }
      : await performAndStageReprovisionRecovery(tx, deps, {
        decision,
        taskId,
        handExecutionId,
        executionResourceKey: input.executionResourceKey,
        now,
      });
    const evidence = preparedEvidence.evidence;

    const latestContext = await loadReprovisionRecoveryContext(tx, { decision, taskId, handExecutionId });
    const cancelAt = recoveryActionTerminalAt(evidence.providerActions, "cancel") ?? now;
    const destroyAt = recoveryActionTerminalAt(evidence.providerActions, "destroy") ?? now;

    await upsertRuntimeResourcePg(tx, {
      id: latestContext.hand.id,
      resourceType: "hand_execution",
      resourceKey: latestContext.hand.resourceKey,
      runId: latestContext.hand.runId,
      taskId: latestContext.hand.taskId,
      sessionId: latestContext.hand.sessionId,
      scope: latestContext.hand.scope,
      status: "lost",
      title: latestContext.hand.title,
      payload: {
        ...(isPlainObject(latestContext.hand.payload) ? latestContext.hand.payload : {}),
        status: "lost",
        terminalAt: cancelAt,
        lostReason: "reprovision-hand",
        recoveryDecisionId: decision.decisionId,
      },
      summary: latestContext.hand.summary,
      metrics: latestContext.hand.metrics,
      expiresAt: latestContext.hand.expiresAt,
    });

    if (latestContext.oldHandBinding && latestContext.oldHandBinding.status !== "lost") {
      await upsertRuntimeResourcePg(tx, {
        id: latestContext.oldHandBinding.id,
        resourceType: "hand_binding",
        resourceKey: latestContext.oldHandBinding.resourceKey,
        runId: latestContext.oldHandBinding.runId,
        taskId: latestContext.oldHandBinding.taskId,
        sessionId: latestContext.oldHandBinding.sessionId,
        scope: latestContext.oldHandBinding.scope,
        status: "lost",
        title: latestContext.oldHandBinding.title,
        payload: {
          ...(isPlainObject(latestContext.oldHandBinding.payload) ? latestContext.oldHandBinding.payload : {}),
          status: "lost",
          terminalAt: destroyAt,
          lostReason: "reprovision-hand",
          recoveryDecisionId: decision.decisionId,
        },
        summary: latestContext.oldHandBinding.summary,
        metrics: latestContext.oldHandBinding.metrics,
        expiresAt: latestContext.oldHandBinding.expiresAt,
      });
    }

    await tx.query(
      "update southstar.workflow_tasks set status = 'pending', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
      [decision.payload.runId, taskId],
    );

    await resolveRuntimeExceptionPg(tx, {
      runId: decision.payload.runId,
      resourceKey: latestContext.exception.resourceKey,
      resolvedAt: now,
      reason: "reprovision-hand applied",
    });

    await completeRecoveryExecutionPg(tx, {
      runId: decision.payload.runId,
      executionResourceKey: input.executionResourceKey,
      status: "succeeded",
      completedAt: recoveryActionTerminalAt(evidence.providerActions, "provision") ?? now,
      stateChanges: evidence.stateChanges,
      providerActions: evidence.providerActions,
    });
    const result = await finalizeRecoveryDecisionAppliedPg(tx, { decision, executionResourceKey: input.executionResourceKey, now });
    return {
      ...result,
      ...(preparedEvidence.cancelExecution ? { cancelExecution: preparedEvidence.cancelExecution } : {}),
    };
  });
}

async function lockRecoveryExecutionForUpdatePg(
  db: SouthstarDb,
  executionResourceKey: string,
): Promise<RuntimeResourceRecord> {
  const execution = mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [RECOVERY_EXECUTION_RESOURCE_TYPE, executionResourceKey],
  ));
  if (!execution) throw new Error(`recovery execution ${executionResourceKey} not found`);
  return execution;
}

async function performAndStageReprovisionRecovery(
  db: SouthstarDb,
  deps: ManagedRecoveryDecisionApplierDeps,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    taskId: string;
    handExecutionId: string;
    executionResourceKey: string;
    now: string;
  },
): Promise<PreparedRecoveryExecutionEvidence> {
  const context = await loadReprovisionRecoveryContext(db, {
    decision: input.decision,
    taskId: input.taskId,
    handExecutionId: input.handExecutionId,
  });
  const managed = await createPostgresRecoveryController({
    db,
    sessionStore: createPostgresSessionStore(db),
    brainProvider: deps.brainProvider,
    handProvider: deps.handProvider,
  }).recover({
    runId: input.decision.payload.runId,
    taskId: input.taskId,
    sessionId: context.sessionId,
    strategy: "reprovision-hand",
    reason: input.decision.payload.reason,
    handName: handNameFromBinding(context.oldHandBinding) ?? "workspace",
    handResources: handResourcesFromDecision(input.decision),
  });

  const evidence = await reprovisionRecoveryExecutionEvidence({
    decision: input.decision,
    taskId: input.taskId,
    context,
    managed,
    providerId: deps.handProvider.providerId,
    providerActions: deps.providerActions,
    now: input.now,
  });

  const staged = await stageRecoveryExecutionEvidenceWithStatusPg(db, {
    executionResourceKey: input.executionResourceKey,
    evidence,
    now: input.now,
  });
  const cancelAction = staged.evidence.providerActions.find((action) => action.action === "cancel");
  const handPayload = isPlainObject(context.hand.payload) ? context.hand.payload : {};
  const externalJobId = stringValue(handPayload.externalJobId);
  return {
    ...staged,
    ...(staged.staged && cancelAction?.status === "requested" && externalJobId
      ? {
        cancelExecution: {
          providerId: cancelAction.providerId,
          externalJobId,
          runId: input.decision.payload.runId,
          evidenceRef: context.hand.resourceKey,
          reason: "reprovision-hand",
        },
      }
      : {}),
  };
}

async function performAndStageWakeNewBrainRecovery(
  db: SouthstarDb,
  deps: ManagedRecoveryDecisionApplierDeps,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    taskId: string;
    sessionId: string;
    context: SimpleRecoveryContext;
    executionResourceKey: string;
    now: string;
  },
): Promise<RecoveryExecutionEvidence> {
  const checkpoint = await createPostgresSessionStore(db).createCheckpoint({
    id: `checkpoint-${input.decision.decisionId}-wake-new-brain`,
    runId: input.decision.payload.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    resourceKey: `${input.decision.resourceKey}:wake-new-brain:before-recovery`,
    checkpointType: "before-recovery",
    summary: `Before recovery wake-new-brain: ${input.decision.payload.reason}`,
    eventRange: {
      fromSequence: 0,
      toSequence: await maxSessionSequence(db, input.decision.payload.runId, input.sessionId, 0),
    },
    refs: { recoveryDecisionIds: [input.decision.decisionId] },
    metrics: { strategy: "wake-new-brain", providerAction: "requested" },
  });

  const evidence = wakeNewBrainRecoveryExecutionEvidence({
    decision: input.decision,
    taskId: input.taskId,
    context: input.context,
    checkpointId: checkpoint.id,
    providerId: deps.brainProvider.providerId,
    now: input.now,
  });

  return await stageRecoveryExecutionEvidencePg(db, {
    executionResourceKey: input.executionResourceKey,
    evidence,
    now: input.now,
  });
}

async function loadSimpleRecoveryContext(
  db: SouthstarDb,
  decision: RuntimeRecoveryDecisionRecord,
): Promise<SimpleRecoveryContext> {
  const run = await db.maybeOne<{ status: string }>(
    "select status from southstar.workflow_runs where id = $1 for update",
    [decision.payload.runId],
  );
  if (!run) throw new Error(`workflow run ${decision.payload.runId} not found`);

  const task = decision.payload.taskId
    ? await db.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [decision.payload.runId, decision.payload.taskId],
    )
    : null;
  if (decision.payload.taskId && !task) {
    throw new Error(`workflow task ${decision.payload.taskId} does not belong to run ${decision.payload.runId}`);
  }

  const exception = mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and run_id = $2
        and payload_json->>'exceptionId' = $3
      for update`,
    [RUNTIME_EXCEPTION_RESOURCE_TYPE, decision.payload.runId, decision.payload.exceptionId],
  ));
  if (!exception) throw new Error(`runtime exception ${decision.payload.exceptionId} not found`);

  const hand = decision.payload.handExecutionId
    ? mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = 'hand_execution'
          and resource_key = $1
        for update`,
      [decision.payload.handExecutionId],
    ))
    : null;

  const handPayload = isPlainObject(hand?.payload) ? hand.payload : {};
  const exceptionPayload = isPlainObject(exception.payload) ? exception.payload : {};
  const sessionId = stringValue(hand?.sessionId)
    ?? stringValue(handPayload.sessionId)
    ?? stringValue(exception.sessionId)
    ?? stringValue(exceptionPayload.sessionId);

  return { task, run, exception, hand, sessionId };
}

async function loadReprovisionRecoveryContext(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; taskId: string; handExecutionId: string },
): Promise<ReprovisionRecoveryContext> {
  const { decision, taskId, handExecutionId } = input;
  await db.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
  const task = await db.maybeOne<{ status: string }>(
    "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
    [decision.payload.runId, taskId],
  );
  if (!task) throw new Error(`workflow task ${taskId} does not belong to run ${decision.payload.runId}`);

  const hand = mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = 'hand_execution'
        and resource_key = $1
      for update`,
    [handExecutionId],
  ));
  if (!hand) throw new Error(`hand execution ${handExecutionId} not found`);

  const exception = mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and run_id = $2
        and payload_json->>'exceptionId' = $3
      for update`,
    [RUNTIME_EXCEPTION_RESOURCE_TYPE, decision.payload.runId, decision.payload.exceptionId],
  ));
  if (!exception) throw new Error(`runtime exception ${decision.payload.exceptionId} not found`);

  const oldHandBindingId = oldHandBindingIdForRecovery(decision, hand, exception);
  const oldHandBinding = oldHandBindingId
    ? mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = 'hand_binding'
          and resource_key = $1
        for update`,
      [oldHandBindingId],
    ))
    : null;

  const handPayload = isPlainObject(hand.payload) ? hand.payload : {};
  const exceptionPayload = isPlainObject(exception.payload) ? exception.payload : {};
  const sessionId = stringValue(hand.sessionId)
    ?? stringValue(handPayload.sessionId)
    ?? stringValue(exception.sessionId)
    ?? stringValue(exceptionPayload.sessionId);
  if (!sessionId) throw new Error("reprovision-hand decision missing sessionId");

  return { task, hand, exception, oldHandBinding, sessionId };
}

function simpleRecoveryExecutionEvidence(input: {
  decision: RuntimeRecoveryDecisionRecord;
  context: SimpleRecoveryContext;
}): RecoveryExecutionEvidence {
  const path = input.decision.payload.path;
  const stateChanges: RecoveryExecutionStateChange[] = [];
  if (path === "retry-same-task-new-attempt" && input.context.hand) {
    stateChanges.push({
      resourceType: "hand_execution",
      resourceKey: input.context.hand.resourceKey,
      fromStatus: input.context.hand.status,
      toStatus: "superseded",
      reason: path,
    });
  }
  if (path === "retry-same-task-new-attempt" || path === "repair-artifact") {
    stateChanges.push({
      resourceType: "workflow_task",
      resourceKey: `${input.decision.payload.runId}:${input.decision.payload.taskId}`,
      fromStatus: input.context.task?.status,
      toStatus: "pending",
      reason: path,
    });
  } else if (path === "block-for-operator") {
    stateChanges.push({
      resourceType: "workflow_task",
      resourceKey: `${input.decision.payload.runId}:${input.decision.payload.taskId}`,
      fromStatus: input.context.task?.status,
      toStatus: "blocked",
      reason: path,
    });
  } else if (path === "fail-task") {
    stateChanges.push({
      resourceType: "workflow_task",
      resourceKey: `${input.decision.payload.runId}:${input.decision.payload.taskId}`,
      fromStatus: input.context.task?.status,
      toStatus: "failed",
      reason: path,
    });
  } else if (path === "fail-run") {
    stateChanges.push({
      resourceType: "workflow_run",
      resourceKey: input.decision.payload.runId,
      fromStatus: input.context.run.status,
      toStatus: "failed",
      reason: path,
    });
  }

  if (path === "block-for-operator") {
    stateChanges.push({
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: input.decision.resourceKey,
      fromStatus: "applying",
      toStatus: "blocked",
      reason: "block-for-operator blocked",
    });
    return { stateChanges, providerActions: [] };
  }

  stateChanges.push(
    {
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: input.decision.resourceKey,
      fromStatus: "applying",
      toStatus: "applied",
      reason: `${path} applied`,
    },
    {
      resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
      resourceKey: input.context.exception.resourceKey,
      fromStatus: input.context.exception.status,
      toStatus: "resolved",
      reason: `${path} applied`,
    },
  );
  return { stateChanges, providerActions: [] };
}

function requeueRecoveryExecutionEvidence(input: {
  decision: RuntimeRecoveryDecisionRecord;
  task: { status: string };
  hand: RuntimeResourceRecord;
  exception: RuntimeResourceRecord;
  cancelAction: RecoveryExecutionProviderAction;
}): RecoveryExecutionEvidence {
  return {
    providerActions: [input.cancelAction],
    stateChanges: [
      {
        resourceType: "hand_execution",
        resourceKey: input.hand.resourceKey,
        fromStatus: input.hand.status,
        toStatus: "lost",
        reason: "requeue-hand-execution",
      },
      {
        resourceType: "workflow_task",
        resourceKey: `${input.decision.payload.runId}:${input.decision.payload.taskId}`,
        fromStatus: input.task.status,
        toStatus: "pending",
        reason: "requeue-hand-execution",
      },
      {
        resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
        resourceKey: input.decision.resourceKey,
        fromStatus: "applying",
        toStatus: "applied",
        reason: "requeue-hand-execution applied",
      },
      {
        resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
        resourceKey: input.exception.resourceKey,
        fromStatus: input.exception.status,
        toStatus: "resolved",
        reason: "requeue-hand-execution applied",
      },
    ],
  };
}

function wakeNewBrainRecoveryExecutionEvidence(input: {
  decision: RuntimeRecoveryDecisionRecord;
  taskId: string;
  context: SimpleRecoveryContext;
  checkpointId: string;
  providerId: string;
  now: string;
}): RecoveryExecutionEvidence {
  return {
    stateChanges: [
      {
        resourceType: "session_checkpoint",
        resourceKey: input.checkpointId,
        toStatus: "created",
        reason: "wake-new-brain before-recovery checkpoint",
      },
      {
        resourceType: "workflow_task",
        resourceKey: `${input.decision.payload.runId}:${input.taskId}`,
        fromStatus: input.context.task?.status,
        toStatus: "pending",
        reason: "wake-new-brain",
      },
      {
        resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
        resourceKey: input.decision.resourceKey,
        fromStatus: "applying",
        toStatus: "applied",
        reason: "wake-new-brain applied",
      },
      {
        resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
        resourceKey: input.context.exception.resourceKey,
        fromStatus: input.context.exception.status,
        toStatus: "resolved",
        reason: "wake-new-brain applied",
      },
    ],
    providerActions: [
      {
        providerId: input.providerId,
        action: "wake",
        status: "requested",
        metadata: {
          checkpointId: input.checkpointId,
          requestedAt: input.now,
          recoveryDecisionId: input.decision.decisionId,
        },
      },
    ],
  };
}

async function reprovisionRecoveryExecutionEvidence(input: {
  decision: RuntimeRecoveryDecisionRecord;
  taskId: string;
  context: ReprovisionRecoveryContext;
  managed: {
    recoveryDecisionId: string;
    beforeRecoveryCheckpointId: string;
    handBindingId?: string;
    executionEventId: string;
  };
  providerId: string;
  providerActions?: RecoveryProviderActions;
  now: string;
}): Promise<RecoveryExecutionEvidence> {
  const oldBindingProviderId = providerIdFromBinding(input.context.oldHandBinding) ?? input.providerId;
  const stateChanges: RecoveryExecutionStateChange[] = [
    {
      resourceType: "hand_execution",
      resourceKey: input.context.hand.resourceKey,
      fromStatus: input.context.hand.status,
      toStatus: "lost",
      reason: "reprovision-hand",
    },
  ];
  if (input.context.oldHandBinding) {
    stateChanges.push({
      resourceType: "hand_binding",
      resourceKey: input.context.oldHandBinding.resourceKey,
      fromStatus: input.context.oldHandBinding.status,
      toStatus: "lost",
      reason: "reprovision-hand",
    });
  }
  stateChanges.push(
    {
      resourceType: "session_checkpoint",
      resourceKey: input.managed.beforeRecoveryCheckpointId,
      toStatus: "created",
      reason: "reprovision-hand before-recovery checkpoint",
    },
    ...(input.managed.handBindingId
      ? [{
        resourceType: "hand_binding",
        resourceKey: input.managed.handBindingId,
        toStatus: "provisioned",
        reason: "reprovision-hand replacement",
      }]
      : []),
    {
      resourceType: "workflow_task",
      resourceKey: `${input.decision.payload.runId}:${input.taskId}`,
      fromStatus: input.context.task.status,
      toStatus: "pending",
      reason: "reprovision-hand",
    },
    {
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: input.decision.resourceKey,
      fromStatus: "applying",
      toStatus: "applied",
      reason: "reprovision-hand applied",
    },
    {
      resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
      resourceKey: input.context.exception.resourceKey,
      fromStatus: input.context.exception.status,
      toStatus: "resolved",
      reason: "reprovision-hand applied",
    },
  );

  const handPayload = isPlainObject(input.context.hand.payload) ? input.context.hand.payload : {};
  const providerActions: RecoveryExecutionProviderAction[] = [
    requestedCancelAction({
      providerActions: input.providerActions,
      providerId: oldBindingProviderId,
      externalJobId: stringValue(handPayload.externalJobId),
      evidenceRef: input.context.hand.resourceKey,
      now: input.now,
    }),
  ];
  if (input.context.oldHandBinding) {
    providerActions.push({
      providerId: oldBindingProviderId,
      action: "destroy",
      status: input.context.oldHandBinding.status === "lost" ? "skipped" : "requested",
      evidenceRef: input.context.oldHandBinding.resourceKey,
      attemptedAt: input.now,
    });
  }
  providerActions.push({
    providerId: input.providerId,
    action: "provision",
    status: "succeeded",
    evidenceRef: input.managed.handBindingId,
    attemptedAt: input.now,
    succeededAt: input.now,
    metadata: {
      managedRecoveryDecisionId: input.managed.recoveryDecisionId,
      beforeRecoveryCheckpointId: input.managed.beforeRecoveryCheckpointId,
      executionEventId: input.managed.executionEventId,
    },
  });

  return { stateChanges, providerActions };
}

async function stageRecoveryExecutionEvidencePg(
  db: SouthstarDb,
  input: { executionResourceKey: string; evidence: RecoveryExecutionEvidence; now: string },
): Promise<RecoveryExecutionEvidence> {
  return (await stageRecoveryExecutionEvidenceWithStatusPg(db, input)).evidence;
}

async function stageRecoveryExecutionEvidenceWithStatusPg(
  db: SouthstarDb,
  input: { executionResourceKey: string; evidence: RecoveryExecutionEvidence; now: string },
): Promise<StagedRecoveryExecutionEvidence> {
  const execution = mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey],
  ));
  if (!execution) throw new Error(`recovery execution ${input.executionResourceKey} not found`);
  if (execution.status !== "started") {
    throw new Error(`recovery execution ${input.executionResourceKey} is ${execution.status}, expected started`);
  }

  const payload = execution.payload as RecoveryExecutionPayload;
  const existingEvidence = stagedRecoveryExecutionEvidence(payload);
  if (existingEvidence) return { evidence: existingEvidence, staged: false };

  await upsertRuntimeResourcePg(db, {
    id: execution.id,
    resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
    resourceKey: execution.resourceKey,
    runId: execution.runId,
    taskId: execution.taskId,
    sessionId: execution.sessionId,
    scope: execution.scope,
    status: "started",
    title: execution.title,
    payload: {
      ...payload,
      stateChanges: input.evidence.stateChanges,
      providerActions: input.evidence.providerActions,
    },
    summary: {
      ...(isPlainObject(execution.summary) ? execution.summary : {}),
      evidenceStagedAt: input.now,
      stateChangeCount: input.evidence.stateChanges.length,
      providerActionCount: input.evidence.providerActions.length,
    },
    metrics: execution.metrics,
    expiresAt: execution.expiresAt,
  });
  return { evidence: input.evidence, staged: true };
}

async function repairTerminalRecoveryExecutionPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<string | undefined> {
  const execution = await getResourceByKeyPg(db, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey);
  if (!execution) return undefined;
  if (execution.status !== "started") return execution.resourceKey;

  const reason = terminalDecisionReason(input.decision);
  const completedAt = terminalDecisionCompletedAt(input.decision, execution, input.now);
  await completeRecoveryExecutionPg(db, {
    runId: input.decision.payload.runId,
    executionResourceKey: input.executionResourceKey,
    status: input.decision.status,
    completedAt,
    stateChanges: [
      {
        resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
        resourceKey: input.decision.resourceKey,
        fromStatus: "applying",
        toStatus: input.decision.status,
        reason,
      },
    ],
    providerActions: [],
  });
  return execution.resourceKey;
}

function terminalDecisionCompletedAt(
  decision: RuntimeRecoveryDecisionRecord,
  execution: RuntimeResourceRecord | null,
  fallback: string,
): string {
  const payload = decision.payload as RecoveryDecisionPayload & Record<string, unknown>;
  const terminalAt =
    payload.blockedAt ??
    payload.failedAt ??
    payload.supersededAt ??
    payload.appliedAt ??
    (execution?.payload as Partial<RecoveryExecutionPayload> | undefined)?.completedAt ??
    (execution?.payload as Partial<RecoveryExecutionPayload> | undefined)?.createdAt;
  return typeof terminalAt === "string" && terminalAt.trim().length > 0 ? terminalAt : fallback;
}

function terminalDecisionReason(decision: RuntimeRecoveryDecisionRecord): string {
  const statusReason = (decision.payload as RecoveryDecisionPayload & { statusReason?: unknown }).statusReason;
  return typeof statusReason === "string" && statusReason.trim().length > 0
    ? statusReason
    : `decision already ${decision.status}`;
}

function terminalDecisionApplyResult(
  decision: RuntimeRecoveryDecisionRecord,
  executionResourceKey: string,
): RecoveryDecisionApplyResult {
  if (!isTerminalDecisionStatus(decision.status)) {
    throw new Error(`recovery decision ${decision.resourceKey} is not terminal`);
  }
  return {
    status: decision.status,
    executionResourceKey,
    reason: terminalDecisionReason(decision),
  };
}

function isTerminalDecisionStatus(status: RecoveryDecisionStatus): status is "applied" | "blocked" | "failed" | "superseded" {
  return status === "applied" || status === "blocked" || status === "failed" || status === "superseded";
}

function recoveryExecutionStatusForTerminalDecision(status: RecoveryDecisionStatus): "blocked" | "failed" | "superseded" | null {
  if (status === "blocked" || status === "failed" || status === "superseded") return status;
  return null;
}

function stagedRecoveryExecutionEvidence(payload: RecoveryExecutionPayload): RecoveryExecutionEvidence | null {
  if (payload.stateChanges.length === 0 && payload.providerActions.length === 0) return null;
  return {
    stateChanges: payload.stateChanges,
    providerActions: payload.providerActions,
  };
}

function requeueTerminalAt(providerActions: RecoveryExecutionProviderAction[]): string | undefined {
  const cancelAction = providerActions.find((action) => action.action === "cancel" && action.status === "succeeded");
  return cancelAction?.succeededAt ?? cancelAction?.completedAt ?? cancelAction?.attemptedAt;
}

function recoveryActionTerminalAt(
  providerActions: RecoveryExecutionProviderAction[],
  actionName: RecoveryExecutionProviderAction["action"],
): string | undefined {
  const action = providerActions.find((item) => item.action === actionName && item.status === "succeeded");
  return action?.succeededAt ?? action?.completedAt ?? action?.attemptedAt;
}

async function maxSessionSequence(db: SouthstarDb, runId: string, sessionId: string, fallback: number): Promise<number> {
  const row = await db.maybeOne<{ max_sequence: number | string | null }>(
    "select max(sequence) as max_sequence from southstar.workflow_history where run_id = $1 and session_id = $2",
    [runId, sessionId],
  );
  const value = Number(row?.max_sequence ?? fallback);
  return Number.isFinite(value) ? Math.max(value, fallback) : fallback;
}

function simpleRecoveryTerminalAt(
  evidence: RecoveryExecutionEvidence,
  executionPayload: RecoveryExecutionPayload,
  fallback: string,
): string {
  const providerTerminalAt = evidence.providerActions
    .map((action) => action.succeededAt ?? action.completedAt ?? action.attemptedAt)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return providerTerminalAt ?? executionPayload.createdAt ?? fallback;
}

function isSimpleRecoveryPath(path: string): boolean {
  return path === "retry-same-task-new-attempt"
    || path === "repair-artifact"
    || path === "block-for-operator"
    || path === "fail-task"
    || path === "fail-run";
}

function isSessionRecoveryPath(path: string): boolean {
  return path === "fork-session" || path === "reset-session" || path === "rollback-session";
}

function missingTaskOrHandReason(decision: RuntimeRecoveryDecisionRecord): string | null {
  if (!decision.payload.taskId) return `${decision.payload.path} decision missing taskId`;
  if (!decision.payload.handExecutionId) return `${decision.payload.path} decision missing handExecutionId`;
  return null;
}

function missingReprovisionDeps(deps: RecoveryDecisionApplierDeps): string[] {
  const missing: string[] = [];
  if (!deps.sessionStore) missing.push("sessionStore");
  if (!deps.brainProvider) missing.push("brainProvider");
  if (!deps.handProvider) missing.push("handProvider");
  return missing;
}

function missingWakeNewBrainDeps(deps: RecoveryDecisionApplierDeps): string[] {
  const missing: string[] = [];
  if (!deps.sessionStore) missing.push("sessionStore");
  if (!deps.brainProvider) missing.push("brainProvider");
  return missing;
}

function isReprovisionBlockableError(message: string, decision: RuntimeRecoveryDecisionRecord): boolean {
  return message === `hand execution ${decision.payload.handExecutionId} not found`
    || message === `workflow task ${decision.payload.taskId} does not belong to run ${decision.payload.runId}`
    || message === `runtime exception ${decision.payload.exceptionId} not found`
    || message === "reprovision-hand decision missing sessionId"
    || message === "reprovision-hand decision missing taskId"
    || message === "reprovision-hand decision missing handExecutionId";
}

function isSimpleRecoveryBlockableError(message: string, decision: RuntimeRecoveryDecisionRecord): boolean {
  return message === `workflow run ${decision.payload.runId} not found`
    || message === `workflow task ${decision.payload.taskId} does not belong to run ${decision.payload.runId}`
    || message === `runtime exception ${decision.payload.exceptionId} not found`
    || message === `${decision.payload.path} decision missing taskId`;
}

function isWakeNewBrainBlockableError(message: string, decision: RuntimeRecoveryDecisionRecord): boolean {
  return message === `workflow run ${decision.payload.runId} not found`
    || message === `workflow task ${decision.payload.taskId} does not belong to run ${decision.payload.runId}`
    || message === `runtime exception ${decision.payload.exceptionId} not found`
    || message === "wake-new-brain decision missing sessionId"
    || message === "wake-new-brain decision missing taskId";
}

function isSessionRecoveryBlockableError(message: string, decision: RuntimeRecoveryDecisionRecord): boolean {
  return message === `workflow run ${decision.payload.runId} not found`
    || message === `workflow task ${decision.payload.taskId} does not belong to run ${decision.payload.runId}`
    || message === `runtime exception ${decision.payload.exceptionId} not found`
    || message === `${decision.payload.path} decision missing taskId`
    || message === "rollback-session requires workspaceSnapshotRef"
    || message === "rollback-session requires operator approval";
}

function oldHandBindingIdForRecovery(
  decision: RuntimeRecoveryDecisionRecord,
  hand: RuntimeResourceRecord,
  exception: RuntimeResourceRecord,
): string | undefined {
  const decisionPayload = decision.payload as RecoveryDecisionPayload & Record<string, unknown>;
  const handPayload = isPlainObject(hand.payload) ? hand.payload : {};
  const exceptionPayload = isPlainObject(exception.payload) ? exception.payload : {};
  return stringValue(handPayload.handBindingId)
    ?? stringValue(decisionPayload.handBindingId)
    ?? stringValue(exceptionPayload.handBindingId);
}

function handNameFromBinding(binding: RuntimeResourceRecord | null): string | undefined {
  if (!binding || !isPlainObject(binding.payload)) return undefined;
  return stringValue(binding.payload.handName);
}

function providerIdFromBinding(binding: RuntimeResourceRecord | null): string | undefined {
  if (!binding || !isPlainObject(binding.payload)) return undefined;
  return stringValue(binding.payload.providerId);
}

function handResourcesFromDecision(decision: RuntimeRecoveryDecisionRecord): Record<string, unknown> {
  const payload = decision.payload as RecoveryDecisionPayload & Record<string, unknown>;
  return isPlainObject(payload.handResources) ? payload.handResources : {};
}

async function claimRecoveryDecisionApplyingPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; now: string },
): Promise<RuntimeRecoveryDecisionRecord> {
  return await db.tx(async (tx) => {
    const current = requireRecoveryDecision(await getRecoveryDecisionByKeyForUpdatePg(tx, input.decision.resourceKey));
    if (shouldWaitForRollbackSessionApproval(current)) {
      const payload = {
        ...current.payload,
        statusReason: "rollback-session waiting for operator approval",
      };
      await upsertRuntimeResourcePg(tx, {
        id: current.decisionId,
        resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
        resourceKey: current.resourceKey,
        runId: current.payload.runId,
        taskId: current.payload.taskId,
        scope: "recovery",
        status: "waiting_operator_approval",
        title: "Runtime recovery decision: rollback-session",
        payload,
        summary: {
          exceptionId: current.payload.exceptionId,
          path: current.payload.path,
          waitingAt: input.now,
        },
      });
      return requireRecoveryDecision(await getResourceByKeyPg(tx, RECOVERY_DECISION_RESOURCE_TYPE, current.resourceKey));
    }
    if (current.status === "applying") return current;
    if (current.status !== "recorded" && current.status !== "approved") return current;

    const payload = {
      ...current.payload,
      applyingAt: input.now,
      statusReason: `${current.payload.path} applying`,
    };
    await upsertRuntimeResourcePg(tx, {
      id: current.decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: current.resourceKey,
      runId: current.payload.runId,
      taskId: current.payload.taskId,
      scope: "recovery",
      status: "applying",
      title: `Runtime recovery decision: ${current.payload.path}`,
      payload,
      summary: {
        exceptionId: current.payload.exceptionId,
        path: current.payload.path,
        applyingAt: input.now,
      },
    });
    return requireRecoveryDecision(await getResourceByKeyPg(tx, RECOVERY_DECISION_RESOURCE_TYPE, current.resourceKey));
  });
}

function shouldWaitForRollbackSessionApproval(decision: RuntimeRecoveryDecisionRecord): boolean {
  const payload = decision.payload as RecoveryDecisionPayload & Record<string, unknown>;
  return (decision.status === "recorded" || decision.status === "applying")
    && decision.payload.path === "rollback-session"
    && decision.payload.operatorApprovalRequired === true
    && payload.operatorDecision !== "approved";
}

async function getRecoveryDecisionByKeyForUpdatePg(
  db: SouthstarDb,
  resourceKey: string,
): Promise<RuntimeResourceRecord | null> {
  const row = await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [RECOVERY_DECISION_RESOURCE_TYPE, resourceKey],
  );
  return row ? mapRuntimeResourceRow(row) : null;
}

async function finalizeRecoveryDecisionAppliedPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<RecoveryDecisionApplyResult> {
  return await db.tx(async (tx) => {
    const current = requireRecoveryDecision(await getRecoveryDecisionByKeyForUpdatePg(tx, input.decision.resourceKey));
    if (current.status === "blocked" || current.status === "failed" || current.status === "superseded") {
      return terminalDecisionApplyResult(current, input.executionResourceKey);
    }
    const currentPayload = current.payload as RecoveryDecisionPayload & { appliedAt?: unknown; statusReason?: unknown };
    const appliedAt = typeof currentPayload.appliedAt === "string" && currentPayload.appliedAt.trim().length > 0
      ? currentPayload.appliedAt
      : input.now;
    await appendRecoveryDecisionAppliedHistoryOncePg(tx, { ...input, decision: current, now: appliedAt });
    const payload = {
      ...current.payload,
      appliedAt,
      statusReason: typeof currentPayload.statusReason === "string" && currentPayload.statusReason.trim().length > 0
        ? currentPayload.statusReason
        : `${current.payload.path} applied`,
    };
    await upsertRuntimeResourcePg(tx, {
      id: current.decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: current.resourceKey,
      runId: current.payload.runId,
      taskId: current.payload.taskId,
      scope: "recovery",
      status: "applied",
      title: `Runtime recovery decision: ${current.payload.path}`,
      payload,
      summary: {
        exceptionId: current.payload.exceptionId,
        path: current.payload.path,
        appliedAt,
      },
    });
    return { status: "applied", executionResourceKey: input.executionResourceKey, reason: `${current.payload.path} applied` };
  });
}

async function blockDecision(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    reason: string;
  },
): Promise<RuntimeRecoveryDecisionRecord> {
  return await transitionDecisionTerminalPg(db, {
    ...input,
    status: "blocked",
    terminalAtField: "blockedAt",
  });
}

async function supersedeDecision(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    reason: string;
  },
): Promise<RuntimeRecoveryDecisionRecord> {
  return await transitionDecisionTerminalPg(db, {
    ...input,
    status: "superseded",
    terminalAtField: "supersededAt",
  });
}

async function transitionDecisionTerminalPg(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    reason: string;
    status: "blocked" | "superseded";
    terminalAtField: "blockedAt" | "supersededAt";
  },
): Promise<RuntimeRecoveryDecisionRecord> {
  return await db.tx(async (tx) => {
    const current = requireRecoveryDecision(await getRecoveryDecisionByKeyForUpdatePg(tx, input.decision.resourceKey));
    const terminalDecision = isTerminalDecisionStatus(current.status)
      ? current
      : await writeTerminalDecisionPg(tx, {
        decision: current,
        now: input.now,
        reason: input.reason,
        status: input.status,
        terminalAtField: input.terminalAtField,
      });

    const completionStatus = recoveryExecutionStatusForTerminalDecision(terminalDecision.status);
    if (completionStatus) {
      const execution = await getResourceByKeyPg(tx, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey);
      await completeRecoveryExecutionPg(tx, {
        runId: terminalDecision.payload.runId,
        executionResourceKey: input.executionResourceKey,
        status: completionStatus,
        completedAt: terminalDecisionCompletedAt(terminalDecision, execution, input.now),
        stateChanges: [
          {
            resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
            resourceKey: terminalDecision.resourceKey,
            fromStatus: "applying",
            toStatus: terminalDecision.status,
            reason: terminalDecisionReason(terminalDecision),
          },
        ],
        providerActions: [],
      });
    }

    return terminalDecision;
  });
}

async function writeTerminalDecisionPg(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    now: string;
    reason: string;
    status: "blocked" | "superseded";
    terminalAtField: "blockedAt" | "supersededAt";
  },
): Promise<RuntimeRecoveryDecisionRecord> {
  const payload = {
    ...input.decision.payload,
    [input.terminalAtField]: input.now,
    statusReason: input.reason,
  };
  await upsertRuntimeResourcePg(db, {
    id: input.decision.decisionId,
    resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
    resourceKey: input.decision.resourceKey,
    runId: input.decision.payload.runId,
    taskId: input.decision.payload.taskId,
    scope: "recovery",
    status: input.status,
    title: `Runtime recovery decision: ${input.decision.payload.path}`,
    payload,
    summary: {
      exceptionId: input.decision.payload.exceptionId,
      path: input.decision.payload.path,
      reason: input.reason,
      [input.terminalAtField]: input.now,
    },
  });
  return requireRecoveryDecision(await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, input.decision.resourceKey));
}

async function appendRecoveryDecisionAppliedHistoryOncePg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<void> {
  const idempotencyKey = `${input.decision.resourceKey}:applied`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.decision.payload.runId, idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId: input.decision.payload.runId,
    taskId: input.decision.payload.taskId,
    eventType: "recovery_decision.applied",
    actorType: "orchestrator",
    idempotencyKey,
    payload: {
      recoveryDecisionId: input.decision.decisionId,
      runId: input.decision.payload.runId,
      taskId: input.decision.payload.taskId,
      path: input.decision.payload.path,
      executionResourceKey: input.executionResourceKey,
      result: "applied",
      status: "applied",
      appliedAt: input.now,
    },
  });
}

function requireRecoveryDecision(resource: RuntimeResourceRecord | null): RuntimeRecoveryDecisionRecord {
  if (!resource) throw new Error("recovery decision not found");
  const payload = resource.payload as Partial<RecoveryDecisionPayload>;
  if (
    resource.resourceType !== RECOVERY_DECISION_RESOURCE_TYPE ||
    typeof payload.decisionId !== "string" ||
    typeof payload.exceptionId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.path !== "string"
  ) {
    throw new Error("invalid recovery decision resource");
  }
  return {
    decisionId: payload.decisionId,
    resourceKey: resource.resourceKey,
    status: resource.status as RecoveryDecisionStatus,
    payload: payload as RecoveryDecisionPayload,
  };
}

function mapRuntimeResourceRow(row: RuntimeResourceRow | null): RuntimeResourceRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    runId: row.run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    scope: row.scope,
    status: row.status,
    title: row.title ?? undefined,
    payload: row.payload_json,
    summary: row.summary_json,
    metrics: row.metrics_json,
    expiresAt: row.expires_at ? dateString(row.expires_at) : undefined,
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

function requireString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`requeue-hand-execution decision missing ${label}`);
  return value;
}

function requireDecisionString(value: string | undefined, path: string, label: string): string {
  if (!value) throw new Error(`${path} decision missing ${label}`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstEvidenceRef(values: string[], pattern: RegExp): string | undefined {
  return values.find((value) => pattern.test(value));
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
