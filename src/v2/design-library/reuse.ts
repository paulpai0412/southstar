import type { SouthstarDb } from "../stores/sqlite.ts";
import type { TodoWebFeatureIssuePacket } from "./designer.ts";
import type { TemplateMatchResult, WorkflowTemplatePayload } from "./types.ts";

export function matchValidatedTemplateForIssue(
  db: SouthstarDb,
  input: { issue: TodoWebFeatureIssuePacket },
): TemplateMatchResult {
  const rows = db.prepare(`
    select id, state_json, updated_at
    from library_objects
    where object_kind = 'workflow_template'
    order by updated_at desc
  `).all() as Array<{ id: string; state_json: string; updated_at: string }>;

  const normalizedIssue = normalizeIssue(input.issue);
  for (const row of rows) {
    const state = JSON.parse(row.state_json) as { payload?: unknown } | WorkflowTemplatePayload;
    const candidate = (typeof state === "object" && state !== null && "payload" in state ? state.payload : state) as any;
    if (!candidate || typeof candidate !== "object") continue;
    if (!candidate.lifecycle || !candidate.reuse) continue;
    const payload = candidate as WorkflowTemplatePayload;
    if (payload.lifecycle.status !== "validated") continue;

    const haystack = [
      payload.reuse.signature,
      ...payload.reuse.tags,
      payload.reuse.requirementSpecSnapshot.summary,
    ].join(" ").toLowerCase();

    const overlap = tokenOverlap(normalizedIssue, haystack);
    const missingInputs = payload.reuse.requiredInputs.filter((key) => !hasIssueInput(input.issue, key));
    const confidence = missingInputs.length === 0 ? Math.max(0.85, overlap) : overlap;

    return {
      templateVersionRef: payload.lifecycle.validatedByRunIds.at(-1) ?? row.id,
      confidence,
      missingInputs,
      risk: "low",
      reason: "Validated todo-web software-dev template matched issue signature and required inputs.",
      clarificationQuestionCount: missingInputs.length === 0 ? 0 : missingInputs.length,
    };
  }

  return {
    templateVersionRef: "",
    confidence: 0,
    missingInputs: ["validatedTemplate"],
    risk: "medium",
    reason: "No validated template matched",
    clarificationQuestionCount: 1,
  };
}

function normalizeIssue(issue: TodoWebFeatureIssuePacket): string {
  return [issue.title, issue.body, ...issue.labels, ...issue.acceptanceCriteria]
    .join(" ")
    .toLowerCase();
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\W+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\W+/).filter(Boolean));
  if (leftTokens.size === 0) return 0;
  let matched = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) matched += 1;
  }
  return matched / leftTokens.size;
}

function hasIssueInput(issue: TodoWebFeatureIssuePacket, key: string): boolean {
  switch (key) {
    case "issueTitle":
      return issue.title.length > 0;
    case "issueBody":
      return issue.body.length > 0;
    case "repoPath":
      return issue.repoPath.length > 0;
    case "acceptanceCriteria":
      return issue.acceptanceCriteria.length > 0;
    default:
      return false;
  }
}
