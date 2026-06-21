import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import { assertNoRawCredentialPayloadPg } from "./policy-enforcer.ts";

export type PreExecutionToolProxyPolicyInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId: string;
  value: unknown;
};

export class PreExecutionToolProxyPolicyError extends Error {
  readonly evidenceRef: string;

  constructor(evidenceRef: string) {
    super(`raw credential payload blocked before hand execution: ${evidenceRef}`);
    this.name = "PreExecutionToolProxyPolicyError";
    this.evidenceRef = evidenceRef;
  }
}

export async function enforcePreExecutionToolProxyPolicyPg(
  db: SouthstarDb,
  input: PreExecutionToolProxyPolicyInput,
): Promise<void> {
  const evidenceRef = `${input.handExecutionId}:pre-execution`;
  try {
    await assertNoRawCredentialPayloadPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      handExecutionId: input.handExecutionId,
      evidenceRef,
      value: input.value,
    });
  } catch (error) {
    if (!isRawCredentialAssertionError(error)) throw error;

    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      handExecutionId: input.handExecutionId,
      source: "tool-proxy",
      kind: "tool_proxy_violation",
      severity: "blocking",
      observedAt: new Date().toISOString(),
      evidenceRefs: [evidenceRef],
      providerEvidence: {
        message: "raw credential payload blocked before hand execution",
        evidenceRef,
        phase: "pre-execution",
      },
    });
    await controller.decide(await controller.classify(exception));
    throw new PreExecutionToolProxyPolicyError(evidenceRef);
  }
}

export function isPreExecutionToolProxyPolicyError(error: unknown): error is PreExecutionToolProxyPolicyError {
  return error instanceof PreExecutionToolProxyPolicyError;
}

function isRawCredentialAssertionError(error: unknown): boolean {
  return error instanceof Error && /raw credential detected/i.test(error.message);
}
