import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendRuntimeEvent } from "../signals/events.ts";
import type { ArtifactSchemaEvaluationInput, ArtifactSchemaEvaluationResult } from "./types.ts";

export function evaluateArtifactSchema(input: ArtifactSchemaEvaluationInput): ArtifactSchemaEvaluationResult {
  const missingFields = input.requiredFields.filter((field) => !hasValue(input.artifact[field]));
  return { ok: missingFields.length === 0, missingFields };
}

export function persistEvaluatorResult(db: SouthstarDb, input: {
  runId: string;
  taskId?: string;
  ok: boolean;
  missingFields: string[];
}) {
  return appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "evaluator.completed",
    actorType: "evaluator",
    payload: { ok: input.ok, missingFields: input.missingFields },
  });
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
