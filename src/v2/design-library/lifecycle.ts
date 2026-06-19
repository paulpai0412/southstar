// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendDraftEvent, appendLibraryHistory, appendVersionCreated, getLibraryObject, listLibraryVersions, updateLibraryObjectState } from "./store.ts";
import { validateWorkflowTemplateGraph } from "./template-validator.ts";
import type { WorkflowTemplatePayload } from "./types.ts";

export function approveDraftForRun(db: SouthstarDb, input: {
  draftId: string;
  approvedBy: "user" | "system";
  version: string;
}): { templateDefinitionId: string; templateVersionId: string } {
  const object = getLibraryObject(db, input.draftId);
  if (object.objectKind !== "workflow_template") {
    throw new Error(`approveDraftForRun requires workflow_template draft, got ${object.objectKind}`);
  }
  const payload = normalizeTemplatePayload(object.state);
  const validation = validateWorkflowTemplateGraph(payload);
  if (!validation.ok) {
    throw new Error(`cannot approve invalid draft: ${JSON.stringify(validation.issues)}`);
  }

  const nextPayload: WorkflowTemplatePayload = {
    ...payload,
    lifecycle: {
      ...payload.lifecycle,
      status: "approved_for_run",
    },
  };

  const templateVersionId = `ver-${input.version}-${randomUUID().slice(0, 8)}`;
  appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "workflow_template",
    versionId: templateVersionId,
    payload: nextPayload,
    createdBy: input.approvedBy,
    status: "approved",
  });

  updateLibraryObjectState(db, {
    objectId: object.objectId,
    status: "approved",
    headVersionId: templateVersionId,
    state: {
      ...object.state,
      payload: nextPayload,
      validation,
      approvedForRunVersionId: templateVersionId,
    },
  });

  appendDraftEvent(db, {
    objectId: object.objectId,
    eventType: "draft.approved_for_run",
    status: "approved_for_run",
    payload: {
      approvedBy: input.approvedBy,
      version: input.version,
      templateVersionId,
    },
    actorType: input.approvedBy,
  });

  return {
    templateDefinitionId: object.objectId,
    templateVersionId,
  };
}

export function validateTemplateFromRun(db: SouthstarDb, input: {
  templateVersionId: string;
  runId: string;
  actorType: "runtime" | "system";
}): { templateVersionId: string; status: "validated" } {
  const run = db.prepare("select status from workflow_runs where id = ?").get(input.runId) as { status: string } | undefined;
  if (!run) throw new Error(`unknown run: ${input.runId}`);
  if (!new Set(["passed", "completed"]).has(run.status)) {
    throw new Error(`run ${input.runId} status must be passed/completed before template validation`);
  }

  const stop = db.prepare(`
    select status
    from runtime_resources
    where run_id = ? and resource_type = 'stop_condition_result'
    order by created_at desc
    limit 1
  `).get(input.runId) as { status: string } | undefined;
  if (!stop || stop.status !== "passed") {
    throw new Error(`run ${input.runId} stop condition must be passed before template validation`);
  }

  const acceptedArtifacts = Number((db.prepare(`
    select count(*) as count
    from runtime_resources
    where run_id = ? and resource_type = 'artifact' and status = 'accepted'
  `).get(input.runId) as { count: number }).count);
  if (acceptedArtifacts < 1) {
    throw new Error(`run ${input.runId} must include at least one accepted artifact`);
  }

  const incompleteEvidence = Number((db.prepare(`
    select count(*) as count
    from runtime_resources
    where run_id = ? and resource_type = 'evidence_packet' and status != 'complete'
  `).get(input.runId) as { count: number }).count);
  if (incompleteEvidence > 0) {
    throw new Error(`run ${input.runId} has incomplete evidence packets`);
  }

  const versionRow = db.prepare(`
    select object_id
    from library_history
    where event_type = 'version.created'
      and json_extract(payload_json, '$.versionId') = ?
    order by created_at desc
    limit 1
  `).get(input.templateVersionId) as { object_id: string } | undefined;
  if (!versionRow) {
    throw new Error(`template version not found: ${input.templateVersionId}`);
  }

  const object = getLibraryObject(db, versionRow.object_id);
  const versions = listLibraryVersions(db, object.objectId);
  const current = versions.find((entry) => entry.versionId === input.templateVersionId) ?? versions.at(-1);
  if (!current) throw new Error(`no template versions found for object ${object.objectId}`);
  const payload = current.payload as WorkflowTemplatePayload;

  const nextPayload: WorkflowTemplatePayload = {
    ...payload,
    lifecycle: {
      ...payload.lifecycle,
      status: "validated",
      validatedByRunIds: [...new Set([...(payload.lifecycle.validatedByRunIds ?? []), input.runId])],
    },
  };

  const nextVersionId = `ver-validated-${randomUUID().slice(0, 8)}`;
  appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "workflow_template",
    versionId: nextVersionId,
    payload: nextPayload,
    createdBy: input.actorType,
    status: "approved",
  });
  updateLibraryObjectState(db, {
    objectId: object.objectId,
    status: "approved",
    headVersionId: nextVersionId,
    state: {
      ...object.state,
      payload: nextPayload,
      validatedVersionId: nextVersionId,
      validatedByRunId: input.runId,
    },
  });
  appendLibraryHistory(db, {
    objectId: object.objectId,
    eventType: "template.validated_from_run",
    actorType: input.actorType,
    payload: {
      runId: input.runId,
      fromVersionId: input.templateVersionId,
      templateVersionId: nextVersionId,
    },
  });

  return {
    templateVersionId: nextVersionId,
    status: "validated",
  };
}

function normalizeTemplatePayload(state: Record<string, unknown>): WorkflowTemplatePayload {
  return (state.payload ?? state) as WorkflowTemplatePayload;
}
