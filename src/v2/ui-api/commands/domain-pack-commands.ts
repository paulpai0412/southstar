// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { appendHistoryEvent } from "../../stores/history-store.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { softwareDomainPack } from "../../domain-packs/software.ts";
import { generateConstrainedWorkflowPlan } from "../../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../../workflow-generator/materialize.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type DomainPackCommand = SouthstarCommandRequest<{ goalPrompt?: string; version?: string }> & { domainPackId: string };

export function validateDomainPackCommand(db: SouthstarDb, input: DomainPackCommand): SouthstarCommandResult {
  const pack = resolvePack(input.domainPackId);
  if (!pack) return rejectedCommand(input.commandId, "Select an existing domain pack before validation.");
  const resource = upsertRuntimeResource(db, { resourceType: "domain_pack_validation", resourceKey: `${input.domainPackId}:${input.commandId}`, scope: "domain-pack", status: "passed", title: "Domain pack validation", payload: { domainPackId: pack.id, version: pack.version, issues: [] } });
  return commandResult(db, input.commandId, "domain-pack", "domain_pack.validated", [resource.id], "Validation diagnostics updated.");
}

export function previewDomainPackWorkflowCommand(db: SouthstarDb, input: DomainPackCommand): SouthstarCommandResult {
  const pack = resolvePack(input.domainPackId);
  if (!pack) return rejectedCommand(input.commandId, "Select an existing domain pack before workflow preview.");
  const goalPrompt = input.payload.goalPrompt ?? "新增 calc sum";
  const plan = generateConstrainedWorkflowPlan({ runId: `preview-${input.commandId}`, goalPrompt, domainPack: pack, intentId: "implement_feature" });
  const workflow = materializeGenerationPlan({ plan, domainPack: pack, goalPrompt });
  const resource = upsertRuntimeResource(db, { resourceType: "workflow_preview", resourceKey: `${input.domainPackId}:${input.commandId}`, scope: "domain-pack", status: "generated", title: "Workflow preview", payload: { plan, workflow } });
  return commandResult(db, input.commandId, "domain-pack", "domain_pack.workflow_previewed", [resource.id], "Workflow preview generated.");
}

export function publishDomainPackCommand(db: SouthstarDb, input: DomainPackCommand): SouthstarCommandResult {
  const pack = resolvePack(input.domainPackId);
  if (!pack) return rejectedCommand(input.commandId, "Select an existing domain pack before publishing.");
  const resource = upsertRuntimeResource(db, { resourceType: "domain_pack_snapshot", resourceKey: `${input.domainPackId}:${input.payload.version ?? pack.version}`, scope: "domain-pack", status: "published", title: "Domain pack snapshot", payload: { ...pack, version: input.payload.version ?? pack.version } });
  return commandResult(db, input.commandId, "domain-pack", "domain_pack.published", [resource.id], "Domain pack snapshot published.");
}

function resolvePack(domainPackId: string) {
  return domainPackId === softwareDomainPack.id ? softwareDomainPack : undefined;
}

function commandResult(db: SouthstarDb, commandId: string, runId: string, eventType: string, resourceRefs: string[], next: string): SouthstarCommandResult {
  ensureRun(db, runId);
  const event = appendHistoryEvent(db, { runId, eventType, actorType: "user", payload: { commandId, resourceRefs } });
  return { commandId, accepted: true, status: "applied", affectedRunId: runId, resourceRefs, eventRefs: [String(event.sequence)], nextSuggestedActions: [next] };
}

function ensureRun(db: SouthstarDb, runId: string): void {
  const exists = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (exists) return;
  const now = new Date().toISOString();
  db.prepare(`insert into workflow_runs (id,status,domain,goal_prompt,executor_job_id,workflow_manifest_json,execution_projection_json,snapshot_json,runtime_context_json,metrics_json,created_at,updated_at,completed_at) values (?, 'running', 'software', '', null, '{"tasks":[]}', '{}', '{}', '{}', '{}', ?, ?, null)`).run(runId, now, now);
}
