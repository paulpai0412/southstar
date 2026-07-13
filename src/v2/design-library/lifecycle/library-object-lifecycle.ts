import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";
import {
  deactivateValidationEdgesForSource,
  findLibraryObjectByKeyForUpdate,
  updateLibraryObjectStatus,
} from "../library-graph-store.ts";
import type { LibraryDefinitionStatus, LibraryObjectSummary } from "../types.ts";

export type LibraryObjectLifecycleAction = "approve" | "deprecate" | "block";

export type ApplyLibraryObjectLifecycleActionInput = {
  objectKey: string;
  action: LibraryObjectLifecycleAction;
  actor: string;
  reason: string;
};

export type ApplyLibraryObjectLifecycleActionResult = {
  object: LibraryObjectSummary;
  auditResourceKey: string;
};

export async function applyLibraryObjectLifecycleAction(
  db: SouthstarDb,
  input: ApplyLibraryObjectLifecycleActionInput,
): Promise<ApplyLibraryObjectLifecycleActionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Error("reason is required");

  const nextStatus = statusForAction(input.action);
  const auditResourceKey = `library-lifecycle-${randomUUID()}`;

  return await db.tx(async (tx) => {
    const existing = await findLibraryObjectByKeyForUpdate(tx, input.objectKey);
    if (!existing) throw new Error(`library object not found: ${input.objectKey}`);
    validateTransition(existing.status, nextStatus);

    const object = await updateLibraryObjectStatus(tx, {
      objectKey: input.objectKey,
      status: nextStatus,
    });
    if (object.objectKind === "evaluator_profile" && nextStatus !== "approved") {
      await deactivateValidationEdgesForSource(tx, { fromObjectKey: object.objectKey });
    }
    await upsertRuntimeResourcePg(tx, {
      resourceType: "library_lifecycle_event",
      resourceKey: auditResourceKey,
      scope: "library",
      status: "created",
      title: `${input.action} ${input.objectKey}`,
      payload: {
        schemaVersion: "southstar.library.lifecycle_event.v1",
        objectKey: input.objectKey,
        action: input.action,
        previousStatus: existing.status,
        nextStatus,
        actor: input.actor,
        reason,
        headVersionId: existing.headVersionId,
      },
      summary: {
        objectKey: input.objectKey,
        action: input.action,
        nextStatus,
      },
    });
    return { object, auditResourceKey };
  });
}

function statusForAction(action: LibraryObjectLifecycleAction): LibraryDefinitionStatus {
  if (action === "approve") return "approved";
  if (action === "deprecate") return "deprecated";
  return "blocked";
}

function validateTransition(previous: LibraryDefinitionStatus, next: LibraryDefinitionStatus): void {
  if (previous === "deprecated" && next === "approved") {
    throw new Error("cannot approve deprecated object without a new draft version");
  }
  if (previous === "blocked" && next === "approved") {
    throw new Error("cannot approve blocked object without a new draft version");
  }
}
