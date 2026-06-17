import type { SouthstarDb } from "../stores/sqlite.ts";
import { recordSessionOperation } from "./operations.ts";
import type { SessionCheckpointV1 } from "./types.ts";

export type PiRecoveryClient = {
  readStatus(sessionId: string): Promise<"live" | "missing" | "unknown">;
  rewindToCheckpoint?: (input: { sessionId: string; providerCheckpointId?: string }) => Promise<{ sessionId: string }>;
};

export type AttemptPiNativeRewindInput = {
  runId: string;
  taskId: string;
  oldSessionId: string;
  baseCheckpointId: string;
  anchor: NonNullable<SessionCheckpointV1["hostSessionAnchor"]>;
  client: PiRecoveryClient;
};

export type AttemptPiNativeRewindResult =
  | { status: "succeeded"; sessionId: string }
  | { status: "fallback-required"; reason: string };

export async function attemptPiNativeRewind(db: SouthstarDb, input: AttemptPiNativeRewindInput): Promise<AttemptPiNativeRewindResult> {
  if (input.anchor.host !== "pi") {
    return fail(db, input, "Checkpoint anchor is not a Pi session.");
  }
  if (input.anchor.rewindSupported !== true || !input.client.rewindToCheckpoint) {
    return fail(db, input, "Pi rewind capability unsupported for checkpoint anchor.");
  }
  const status = await input.client.readStatus(input.oldSessionId);
  if (status !== "live") {
    return fail(db, input, `Pi session is ${status}.`);
  }
  try {
    const result = await input.client.rewindToCheckpoint({
      sessionId: input.oldSessionId,
      providerCheckpointId: input.anchor.providerCheckpointId,
    });
    recordSessionOperation(db, {
      runId: input.runId,
      taskId: input.taskId,
      type: "rewind",
      baseCheckpointId: input.baseCheckpointId,
      oldSessionId: input.oldSessionId,
      newSessionId: result.sessionId,
      host: "pi",
      status: "succeeded",
      fallbackUsed: false,
    });
    return { status: "succeeded", sessionId: result.sessionId };
  } catch (error) {
    return fail(db, input, (error as Error).message);
  }
}

function fail(db: SouthstarDb, input: AttemptPiNativeRewindInput, reason: string): AttemptPiNativeRewindResult {
  recordSessionOperation(db, {
    runId: input.runId,
    taskId: input.taskId,
    type: "rewind",
    baseCheckpointId: input.baseCheckpointId,
    oldSessionId: input.oldSessionId,
    host: "pi",
    status: "failed",
    fallbackUsed: true,
    error: reason,
  });
  return { status: "fallback-required", reason };
}
