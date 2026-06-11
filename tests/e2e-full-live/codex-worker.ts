export interface CodexRunnerInput {
  role: "implement" | "verify";
  prompt: string;
  timeout_ms: number;
}

export interface CodexRunnerOutput {
  root_session_id: string;
  child_run_id: string;
  final_response: string;
  duration_ms: number;
}

export interface CodexFullLiveWorkerOutput extends CodexRunnerOutput {
  role: "implement" | "verify";
  shell_fallbacks: 0;
}

export class CodexFullLiveWorker {
  private readonly runner: { run(input: CodexRunnerInput): Promise<CodexRunnerOutput> };

  constructor(runner: { run(input: CodexRunnerInput): Promise<CodexRunnerOutput> } = { run: runCodexSdkChild }) {
    this.runner = runner;
  }

  async runImplementation(input: {
    issue_number: number;
    issue_url: string;
    repo: string;
    branch: string;
    fixture_path: string;
    fixture_content: string;
  }): Promise<CodexFullLiveWorkerOutput> {
    const output = await this.runner.run({
      role: "implement",
      timeout_ms: 300_000,
      prompt: [
        `You are implementing Northstar full live E2E issue ${input.issue_number}.`,
        `Issue: ${input.issue_url}`,
        `Repository: ${input.repo}`,
        `Branch: ${input.branch}`,
        `Fixture path: ${input.fixture_path}`,
        `Fixture content: ${input.fixture_content}`,
        "Do not modify any repository except paulpai0412/northstar-live-sandbox.",
        "Return compact JSON with status, branch, fixture_path, fixture_content, and summary.",
      ].join("\n"),
    });
    return { ...output, role: "implement", shell_fallbacks: 0 };
  }

  async runVerification(input: {
    pr_number: number;
    pr_url: string;
    expected_fixture_path: string;
  }): Promise<CodexFullLiveWorkerOutput> {
    const output = await this.runner.run({
      role: "verify",
      timeout_ms: 180_000,
      prompt: [
        `Verify Northstar full live E2E PR ${input.pr_number}.`,
        `PR: ${input.pr_url}`,
        `Expected fixture path: ${input.expected_fixture_path}`,
        "Return compact JSON evidence with status=pass only if the expected fixture path is present.",
        "Return compact JSON evidence; do not print secrets.",
      ].join("\n"),
    });
    return { ...output, role: "verify", shell_fallbacks: 0 };
  }
}

async function runCodexSdkChild(input: CodexRunnerInput): Promise<CodexRunnerOutput> {
  const started = Date.now();
  const sdk = await import("@openai/codex-sdk");
  const Codex = (sdk as {
    Codex?: new () => {
      startThread(options: Record<string, unknown>): {
        id: string;
        run(prompt: string): Promise<{ finalResponse?: string }>;
      };
    };
  }).Codex;
  if (!Codex) {
    throw new Error("@openai/codex-sdk does not export Codex");
  }
  const codex = new Codex();
  const root = codex.startThread({
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "low",
  });
  const turn = await withTimeout(root.run(input.prompt), input.timeout_ms, `Codex ${input.role} full live worker timed out`);
  return {
    root_session_id: root.id,
    child_run_id: `${root.id}:${input.role}`,
    final_response: turn.finalResponse ?? "",
    duration_ms: Date.now() - started,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
