import { redactSecrets } from "../../src/runtime/redaction.ts";

export interface CleanupClient {
  addIssueComment(number: number, body: string): Promise<{ html_url: string }>;
  closeIssue(number: number): Promise<{ state?: string }>;
  deleteBranch?(branch: string): Promise<void>;
}

export async function closeSmokeIssueWithComment(
  client: CleanupClient,
  issueNumber: number,
  reason: string,
): Promise<{ closed: boolean; comment_url?: string; last_error?: string }> {
  const body = [
    "Northstar full live exception E2E closed this smoke issue.",
    "",
    `Reason: ${redactLiveExceptionText(reason).slice(0, 1000)}`,
  ].join("\n");
  const comment = await client.addIssueComment(issueNumber, body);
  const closed = await client.closeIssue(issueNumber);
  return { closed: closed.state === "closed", comment_url: comment.html_url };
}

export async function cleanupFailedBranch(
  client: CleanupClient,
  branch: string,
): Promise<{ status: "deleted" | "retryable_failed"; branch: string; last_error?: string }> {
  try {
    await client.deleteBranch?.(branch);
    return { status: "deleted", branch };
  } catch (error) {
    return {
      status: "retryable_failed",
      branch,
      last_error: redactLiveExceptionText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function redactLiveExceptionText(value: string): string {
  return redactSecrets(value).replace(/\bgho_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}
