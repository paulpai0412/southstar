import { redactSecrets } from "./redaction.ts";

export interface CommandRunner {
  (command: { command: string; args: string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class CredentialError extends Error {
  readonly code = "GITHUB_CREDENTIAL_MISSING";

  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export async function resolveGitHubToken(input: {
  tokenEnv: string;
  allowGhTokenFallback: boolean;
  env: Record<string, string | undefined>;
  runCommand: CommandRunner;
}): Promise<{ token: string; source: "env" | "gh" }> {
  const envToken = input.env[input.tokenEnv]?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  if (!input.allowGhTokenFallback) {
    throw new CredentialError(`GITHUB_CREDENTIAL_MISSING: set ${input.tokenEnv} or enable gh fallback`);
  }

  const result = await input.runCommand({ command: "gh", args: ["auth", "token"] });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new CredentialError(`GITHUB_CREDENTIAL_MISSING: gh auth token failed: ${redactCredentialOutput(result.stderr)}`);
  }

  return { token: result.stdout.trim(), source: "gh" };
}

function redactCredentialOutput(value: string): string {
  return redactSecrets(value).replace(/\b(?:ghp|gho|github_pat|sk|xoxb|xoxp)_[^\s]+/g, "[REDACTED]");
}
