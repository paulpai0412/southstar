import type { AnyTaskEnvelope } from "../agent-runner/task-envelope.ts";

export type HarnessRunInput = {
  envelope: AnyTaskEnvelope;
  attempt: number;
  repairInstruction?: string;
};

export type HarnessRunResult = {
  artifact: Record<string, unknown>;
  progress: string[];
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
