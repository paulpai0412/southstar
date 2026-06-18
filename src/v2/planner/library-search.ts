import type { SouthstarDb } from "../stores/sqlite.ts";

export type LibrarySearchMatch = {
  ref: string;
  kind: string;
  score: number;
  reason: string;
  payload: Record<string, unknown>;
};

export function searchLibrary(db: SouthstarDb, input: { query: string; kind?: string; limit?: number }): LibrarySearchMatch[] {
  const terms = tokenize(input.query);
  const rows = input.kind
    ? db.prepare("select object_key, object_kind, state_json from library_objects where object_kind = ?").all(input.kind)
    : db.prepare("select object_key, object_kind, state_json from library_objects").all();
  return (rows as Array<{ object_key: string; object_kind: string; state_json: string }>)
    .map((row) => {
      const payload = readPayload(row.state_json);
      const haystack = `${row.object_key} ${JSON.stringify(payload)}`.toLowerCase();
      const overlap = terms.filter((term) => haystack.includes(term)).length;
      const workflowBoost = row.object_kind === "workflow_template" ? workflowIntentBoost(row.object_key, input.query) : 0;
      return {
        ref: row.object_key,
        kind: row.object_kind,
        score: overlap + workflowBoost,
        reason: overlap > 0 || workflowBoost > 0 ? "matched prompt terms and workflow intent" : "available library object",
        payload,
      };
    })
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
    .slice(0, input.limit ?? 10);
}

export function selectWorkflowTemplateRef(goalPrompt: string): string {
  const prompt = goalPrompt.toLowerCase();
  const docsIntent = /(readme|docs|documentation|usage|faq|文件|說明|常見問題)/i.test(prompt);
  const docsOnly = /(不要修改\s*runtime\s*code|不要修改.*code|docs-only|documentation-only|no runtime code|do not modify runtime code)/i.test(prompt);
  if (docsIntent && docsOnly) return "software.workflow.documentation-update";
  if (/(\bbug\b|\bfix\b|failing|failure|broken|diagnose|reproduce|parser|修復|診斷|重現)/i.test(prompt)) return "software.workflow.bug-diagnosis-fix";
  if (/(coverage|test coverage|補測試|測試覆蓋|regression tests only)/i.test(prompt)) return "software.workflow.test-coverage-improvement";
  if (/(refactor|重構|preserve behavior|不可改變|safety net)/i.test(prompt)) return "software.workflow.refactor-safety-net";
  return "software.workflow.feature-implementation";
}

export function shouldIncludeBrowserQa(goalPrompt: string, repoPath?: string): boolean {
  return /(browser|ui|web|frontend|localStorage|DOM|accessibility|瀏覽器|前端|畫面)/i.test(`${goalPrompt} ${repoPath ?? ""}`);
}

function workflowIntentBoost(ref: string, query: string): number {
  return selectWorkflowTemplateRef(query) === ref ? 100 : 0;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((term) => term.length >= 2);
}

function readPayload(stateJson: string): Record<string, unknown> {
  const state = JSON.parse(stateJson) as { payload?: unknown };
  return state.payload && typeof state.payload === "object" && !Array.isArray(state.payload) ? state.payload as Record<string, unknown> : {};
}
