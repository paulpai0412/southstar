import type { SouthstarDb } from "../db/postgres.ts";

export type GoalJourneyStage = "chat" | "requirements" | "library" | "workflow" | "operator" | "complete";

export type GoalJourneyLink = {
  id: string;
  title: string;
  currentStage: GoalJourneyStage;
  chatSessionId?: string;
  workflowSessionId?: string;
  librarySessionId?: string;
  runId?: string;
};

type JourneyResourceRow = {
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  session_id: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  updated_at: Date | string;
};

type JourneyRunRow = {
  id: string;
  status: string;
  goal_prompt: string;
  runtime_context_json: unknown;
  updated_at: Date | string;
};

type JourneyAggregate = {
  id: string;
  title?: string;
  stage: GoalJourneyStage;
  chatSessionId?: string;
  workflowSessionId?: string;
  librarySessionId?: string;
  runId?: string;
  sessionIds: Set<string>;
};

const JOURNEY_RESOURCE_TYPES = [
  "chat_session",
  "library_chat_action",
  "library_import_draft",
  "planner_draft",
  "goal_design_confirmation",
  "goal_validation_resolution",
] as const;

const STAGE_RANK: Record<GoalJourneyStage, number> = {
  chat: 0,
  requirements: 1,
  library: 2,
  workflow: 3,
  operator: 4,
  complete: 5,
};

const TERMINAL_RUN_STATUSES = new Set(["completed", "passed"]);

export async function listGoalJourneyLinksPg(
  db: SouthstarDb,
  input: { sessionIds?: string[]; runIds?: string[] } = {},
): Promise<Record<string, GoalJourneyLink>> {
  const sessionIds = uniqueStrings(input.sessionIds);
  const runIds = uniqueStrings(input.runIds);
  if (sessionIds.length === 0 && runIds.length === 0) return {};

  const resources = (await db.query<JourneyResourceRow>(
    `select resource_type, resource_key, run_id, session_id, status, title,
            payload_json, summary_json, updated_at
       from southstar.runtime_resources
      where resource_type = any($1::text[])
        and (
          ($2::text[] is not null and session_id = any($2::text[]))
          or ($3::text[] is not null and run_id = any($3::text[]))
          or exists (
            select 1
              from southstar.runtime_resources source
             where source.resource_type = 'planner_draft'
               and source.session_id = any($2::text[])
               and (
                 payload_json->>'originGoalDraftId' = source.resource_key
                 or payload_json->>'draftId' = source.resource_key
               )
          )
        )
      order by updated_at desc, resource_key`,
    [
      [...JOURNEY_RESOURCE_TYPES],
      sessionIds.length > 0 ? sessionIds : null,
      runIds.length > 0 ? runIds : null,
    ],
  )).rows;
  const runs = (await db.query<JourneyRunRow>(
    `select id, status, goal_prompt, runtime_context_json, updated_at
       from southstar.workflow_runs
      where ($1::text[] is not null and id = any($1::text[]))
         or ($2::text[] is not null and runtime_context_json->>'sessionId' = any($2::text[]))
      order by updated_at desc, id`,
    [runIds.length > 0 ? runIds : null, sessionIds.length > 0 ? sessionIds : null],
  )).rows;

  return linksForRows(resources, runs, sessionIds, runIds);
}

function linksForRows(
  resources: JourneyResourceRow[],
  runs: JourneyRunRow[],
  requestedSessionIds: string[],
  requestedRunIds: string[],
): Record<string, GoalJourneyLink> {
  const sourceSessionIds = new Map<string, string>();
  for (const resource of resources) {
    if (resource.resource_type === "planner_draft" && resource.session_id) {
      sourceSessionIds.set(resource.resource_key, resource.session_id);
    }
  }

  const groups = new Map<string, JourneyAggregate>();
  const groupFor = (input: {
    sessionId?: string;
    journeyId?: string;
    title?: string;
    stage: GoalJourneyStage;
    kind: "chat" | "workflow" | "library" | "operator";
    runId?: string;
  }): JourneyAggregate | undefined => {
    const rootSessionId = input.sessionId;
    const journeyId = input.journeyId ?? (rootSessionId ? `goal-journey:${rootSessionId}` : input.runId ? `goal-journey:run:${input.runId}` : undefined);
    if (!journeyId) return undefined;
    let group = groups.get(journeyId);
    if (!group) {
      group = { id: journeyId, stage: input.stage, sessionIds: new Set<string>() };
      groups.set(journeyId, group);
    }
    if (rootSessionId) group.sessionIds.add(rootSessionId);
    if (input.title && (!group.title || input.kind === "operator")) group.title = input.title;
    if (STAGE_RANK[input.stage] > STAGE_RANK[group.stage]) group.stage = input.stage;
    if (input.runId) group.runId = input.runId;
    if (input.kind === "workflow" && rootSessionId) group.workflowSessionId = rootSessionId;
    if (input.kind === "chat" && rootSessionId) group.chatSessionId = rootSessionId;
    return group;
  };

  for (const resource of resources) {
    const payload = asRecord(resource.payload_json);
    const summary = asRecord(resource.summary_json);
    const linkedDraftId = stringValue(payload.originGoalDraftId);
    const linkedSessionId = linkedDraftId ? sourceSessionIds.get(linkedDraftId) : undefined;
    const sessionId = linkedSessionId ?? resource.session_id ?? undefined;
    const title = stringValue(summary.goalPrompt)
      ?? stringValue(asRecord(payload.plannerRequest).goalPrompt)
      ?? stringValue(payload.prompt)
      ?? stringValue(payload.requestPrompt)
      ?? resource.title
      ?? undefined;
    const stage = resourceStage(resource);
    const kind = resource.resource_type === "library_chat_action" || resource.resource_type === "library_import_draft"
      ? "library"
      : resource.resource_type === "chat_session"
        ? "chat"
        : "workflow";
    const journeyId = stringValue(payload.journeyId) ?? stringValue(summary.journeyId);
    const group = groupFor({
      sessionId,
      journeyId,
      title,
      stage,
      kind,
      ...(resource.run_id ? { runId: resource.run_id } : {}),
    });
    if (group && kind === "library" && !group.librarySessionId) {
      const librarySessionId = stringValue(payload.piSessionId)
        ?? stringValue(payload.ontologyPiSessionId)
        ?? resource.session_id
        ?? sessionId;
      if (librarySessionId) {
        group.librarySessionId = librarySessionId;
        group.sessionIds.add(librarySessionId);
      }
    }
    if (group && resource.resource_type === "planner_draft" && sessionId) {
      group.chatSessionId ??= sessionId;
    }
  }

  for (const run of runs) {
    const runtimeContext = asRecord(run.runtime_context_json);
    const sessionId = stringValue(runtimeContext.sessionId);
    const group = groupFor({
      sessionId,
      journeyId: stringValue(runtimeContext.journeyId),
      title: run.goal_prompt,
      stage: TERMINAL_RUN_STATUSES.has(run.status) ? "complete" : "operator",
      kind: "operator",
      runId: run.id,
    });
    if (group && sessionId) {
      group.chatSessionId ??= sessionId;
      group.workflowSessionId ??= sessionId;
    }
  }

  const result: Record<string, GoalJourneyLink> = {};
  for (const group of groups.values()) {
    const link: GoalJourneyLink = {
      id: group.id,
      title: group.title ?? group.id,
      currentStage: group.stage,
      ...(group.chatSessionId ? { chatSessionId: group.chatSessionId } : {}),
      ...(group.workflowSessionId ? { workflowSessionId: group.workflowSessionId } : {}),
      ...(group.librarySessionId ? { librarySessionId: group.librarySessionId } : {}),
      ...(group.runId ? { runId: group.runId } : {}),
    };
    const sessionIds = requestedSessionIds.length > 0
      ? [...group.sessionIds].filter((sessionId) => requestedSessionIds.includes(sessionId))
      : [...group.sessionIds];
    for (const sessionId of sessionIds) result[sessionId] = link;
    if (group.runId && requestedRunIds.includes(group.runId)) result[`run:${group.runId}`] = link;
  }
  return result;
}

function resourceStage(resource: JourneyResourceRow): GoalJourneyStage {
  if (resource.resource_type === "library_chat_action" || resource.resource_type === "library_import_draft") return "library";
  if (resource.resource_type === "chat_session") return "chat";
  const payload = asRecord(resource.payload_json);
  const phase = stringValue(payload.goalDesignPhase);
  if (phase === "library_review" || resource.status === "needs_library_input") return "library";
  if (phase === "requirements_review" || phase === "requirements_confirmed" || resource.status === "requirements_review" || resource.status === "needs_input") return "requirements";
  if (phase === "dag_validated" || phase === "ready_to_compose" || phase === "composing" || resource.status === "validated" || resource.status === "ready_for_review") return "workflow";
  return "requirements";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.trim().length > 0))];
}
