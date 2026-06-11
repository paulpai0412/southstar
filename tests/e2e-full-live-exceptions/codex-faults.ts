import type { CodexRunnerInput, CodexRunnerOutput } from "../e2e-full-live/codex-worker.ts";

export type CodexFaultKind = "timeout" | "malformed_artifact" | "empty_response" | "terminal_failure" | "verification_failure";

export function createCodexFaultRunner(kind: CodexFaultKind): { run(input: CodexRunnerInput): Promise<CodexRunnerOutput> } {
  return {
    async run(input) {
      if (kind === "timeout") {
        throw new Error(`Codex ${input.role} full live exception worker timed out`);
      }
      if (kind === "empty_response") {
        return output(input, "");
      }
      if (kind === "malformed_artifact") {
        return output(input, "not-json malformed artifact");
      }
      if (kind === "terminal_failure") {
        return output(input, JSON.stringify({ status: "failed", retryable: false, summary: "terminal child failure" }));
      }
      return output(input, JSON.stringify({ status: "fail", retryable: true, summary: "verification failed by prompt" }));
    },
  };
}

function output(input: CodexRunnerInput, final_response: string): CodexRunnerOutput {
  return {
    root_session_id: `fault-root-${input.role}`,
    child_run_id: `fault-child-${input.role}`,
    final_response,
    duration_ms: 1,
  };
}
