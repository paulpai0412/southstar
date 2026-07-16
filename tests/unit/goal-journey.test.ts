import test from "node:test";
import assert from "node:assert/strict";
import { buildGoalJourney, type GoalJourneyLink } from "../../web/lib/goal-journey";

test("buildGoalJourney keeps the goal title and cross-surface ids in one ordered timeline", () => {
  const link: GoalJourneyLink = {
    id: "journey-42",
    title: "Ship the journey timeline",
    currentStage: "library",
    chatSessionId: "chat-42",
    workflowSessionId: "workflow-42",
    librarySessionId: "library-42",
    runId: "run-42",
  };

  const journey = buildGoalJourney(link);

  assert.equal(journey.id, "journey-42");
  assert.equal(journey.title, "Ship the journey timeline");
  assert.deepEqual(journey.steps.map((step) => step.id), [
    "chat",
    "requirements",
    "library",
    "workflow",
    "operator",
    "complete",
  ]);
  assert.equal(journey.steps.find((step) => step.id === "library")?.status, "current");
  assert.equal(journey.steps.find((step) => step.id === "chat")?.sessionId, "chat-42");
  assert.equal(journey.steps.find((step) => step.id === "workflow")?.sessionId, "workflow-42");
  assert.equal(journey.steps.find((step) => step.id === "operator")?.runId, "run-42");
  assert.equal(journey.steps.find((step) => step.id === "complete")?.status, "pending");
});

test("completed journeys expose a completed terminal step", () => {
  const journey = buildGoalJourney({
    id: "journey-complete",
    title: "Completed goal",
    currentStage: "complete",
    runId: "run-complete",
  });

  assert.equal(journey.steps.at(-1)?.status, "complete");
  assert.equal(journey.currentStage, "complete");
});
