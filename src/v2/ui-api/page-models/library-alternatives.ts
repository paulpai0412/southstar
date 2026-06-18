import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import { searchLibrary } from "../../planner/library-search.ts";

export type LibraryAlternativesPageModel = {
  surface: "southstar.ui.library-alternatives.v1";
  draftId: string;
  taskId?: string;
  matchedTemplates: Array<{ ref: string; score: number; reason: string }>;
  agentProfiles: Array<{ ref: string; score: number; reason: string }>;
  skills: Array<{ ref: string; score: number; reason: string }>;
  mcpGrants: Array<{ ref: string; score: number; reason: string }>;
  rejectedAlternatives: Array<{ ref: string; reason: string }>;
};

export function buildLibraryAlternativesPageModel(db: SouthstarDb, input: { draftId: string; taskId?: string }): LibraryAlternativesPageModel {
  const draft = listResources(db, { resourceType: "planner_draft" }).find((resource) => resource.resourceKey === input.draftId);
  const query = `${draft?.title ?? "software"} ${input.taskId ?? ""}`;
  const toView = (match: { ref: string; score: number; reason: string }) => ({ ref: match.ref, score: match.score, reason: match.reason });
  const rejected = listResources(db, { resourceType: "planner_decision_trace" }).flatMap((resource) => {
    const payload = resource.payload as { rationale?: { rejectedAlternatives?: Array<{ ref: string; reason: string }> } };
    return payload.rationale?.rejectedAlternatives ?? [];
  });
  return {
    surface: "southstar.ui.library-alternatives.v1",
    draftId: input.draftId,
    taskId: input.taskId,
    matchedTemplates: searchLibrary(db, { query, kind: "workflow_template", limit: 5 }).map(toView),
    agentProfiles: searchLibrary(db, { query, kind: "agent_profile", limit: 8 }).map(toView),
    skills: searchLibrary(db, { query, kind: "skill_definition", limit: 8 }).map(toView),
    mcpGrants: searchLibrary(db, { query, kind: "mcp_tool_grant", limit: 8 }).map(toView),
    rejectedAlternatives: rejected,
  };
}
