import type { TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";

export type HarnessRunInput = {
  envelope: TaskEnvelopeV2;
  attempt: number;
  repairInstruction?: string;
};

export type HarnessCommandExecution = {
  ref: string;
  command: string;
  status: "passed" | "failed";
  ok: boolean;
};

export type HarnessRunResult = {
  artifact: Record<string, unknown>;
  progress: string[];
  commandExecutions?: HarnessCommandExecution[];
  metrics?: {
    durationMs?: number;
    toolCalls?: number;
    retryCount?: number;
    tokens?: number;
    costMicrosUsd?: number;
  };
};

export type AgentHarness = {
  id: string;
  run(input: HarnessRunInput): Promise<HarnessRunResult>;
};
