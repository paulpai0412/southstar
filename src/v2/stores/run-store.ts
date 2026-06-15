import type { SouthstarDb } from "./sqlite.ts";

export type WorkflowRunInput = {
  id: string;
  status: string;
  domain: string;
  goalPrompt: string;
  workflowManifestJson: string;
  executionProjectionJson: string;
  snapshotJson: string;
  runtimeContextJson: string;
  metricsJson: string;
};

export type WorkflowRunRecord = WorkflowRunInput & {
  executorJobId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export function createWorkflowRun(db: SouthstarDb, input: WorkflowRunInput): WorkflowRunRecord {
  const now = new Date().toISOString();
  db.prepare(`
    insert into workflow_runs (
      id, status, domain, goal_prompt, executor_job_id, workflow_manifest_json,
      execution_projection_json, snapshot_json, runtime_context_json, metrics_json,
      created_at, updated_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.status,
    input.domain,
    input.goalPrompt,
    null,
    input.workflowManifestJson,
    input.executionProjectionJson,
    input.snapshotJson,
    input.runtimeContextJson,
    input.metricsJson,
    now,
    now,
    null,
  );
  return getWorkflowRun(db, input.id) as WorkflowRunRecord;
}

export function getWorkflowRun(db: SouthstarDb, runId: string): WorkflowRunRecord | null {
  const row = db.prepare("select * from workflow_runs where id = ?").get(runId) as WorkflowRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function updateWorkflowManifest(db: SouthstarDb, runId: string, workflowManifestJson: string): void {
  db.prepare("update workflow_runs set workflow_manifest_json = ?, updated_at = ? where id = ?")
    .run(workflowManifestJson, new Date().toISOString(), runId);
}

type WorkflowRunRow = {
  id: string;
  status: string;
  domain: string;
  goal_prompt: string;
  executor_job_id: string | null;
  workflow_manifest_json: string;
  execution_projection_json: string;
  snapshot_json: string;
  runtime_context_json: string;
  metrics_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function mapRun(row: WorkflowRunRow): WorkflowRunRecord {
  return {
    id: row.id,
    status: row.status,
    domain: row.domain,
    goalPrompt: row.goal_prompt,
    executorJobId: row.executor_job_id,
    workflowManifestJson: row.workflow_manifest_json,
    executionProjectionJson: row.execution_projection_json,
    snapshotJson: row.snapshot_json,
    runtimeContextJson: row.runtime_context_json,
    metricsJson: row.metrics_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
