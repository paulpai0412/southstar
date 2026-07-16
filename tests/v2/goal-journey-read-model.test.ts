import assert from "node:assert/strict";
import test from "node:test";
import { listGoalJourneyLinksPg } from "../../src/v2/read-models/goal-journey.ts";

test("goal journey read model links one session to library, workflow, and run data", async () => {
  const db = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("from southstar.workflow_runs")) {
        return {
          rows: [{
            id: "run-1",
            status: "running",
            goal_prompt: "Ship the journey timeline",
            runtime_context_json: { sessionId: "pi-goal-1" },
            updated_at: new Date("2026-07-16T10:03:00.000Z"),
          }] as T[],
        };
      }
      return {
        rows: [{
          resource_type: "planner_draft",
          resource_key: "draft-1",
          run_id: "run-1",
          session_id: "pi-goal-1",
          status: "validated",
          title: "Planner Draft",
          payload_json: { goalDesignPhase: "dag_validated", plannerRequest: { goalPrompt: "Ship the journey timeline" } },
          summary_json: { goalPrompt: "Ship the journey timeline" },
          updated_at: new Date("2026-07-16T10:02:00.000Z"),
        }, {
          resource_type: "library_import_draft",
          resource_key: "library-import-1",
          run_id: null,
          session_id: "library-action-session-1",
          status: "draft",
          title: "Import journey skill",
          payload_json: { originGoalDraftId: "draft-1", piSessionId: "library-session-1" },
          summary_json: {},
          updated_at: new Date("2026-07-16T10:01:00.000Z"),
        }] as T[],
      };
    },
  };

  const journeys = await listGoalJourneyLinksPg(db as never, { sessionIds: ["pi-goal-1"] });

  assert.deepEqual(journeys, {
    "pi-goal-1": {
      id: "goal-journey:pi-goal-1",
      title: "Ship the journey timeline",
      currentStage: "operator",
      chatSessionId: "pi-goal-1",
      workflowSessionId: "pi-goal-1",
      librarySessionId: "library-session-1",
      runId: "run-1",
    },
  });
});
