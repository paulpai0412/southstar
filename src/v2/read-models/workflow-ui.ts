import type { SouthstarDb } from "../db/postgres.ts";
import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import { getResourceByKeyPg } from "../stores/postgres-runtime-store.ts";

type WorkflowUiInput = { draftId?: string; runId?: string; taskId?: string };

export async function buildWorkflowUiReadModelPg(db: SouthstarDb, input: WorkflowUiInput) {
  if (input.runId) return buildRunWorkflowModel(db, input.runId, input.taskId);
  if (input.draftId) return buildDraftWorkflowModel(db, input.draftId, input.taskId);
  return {
    activeDraft: null,
    canvasModel: { graphId: "empty", mode: "draft", nodes: [], edges: [] },
    selectedDefinition: null,
    agentLibrarySummary: null,
    validationIssues: [],
    repairAttempts: [],
    commands: [],
  };
}

async function buildRunWorkflowModel(db: SouthstarDb, runId: string, taskId?: string) {
  const run = await db.one<{ id: string; status: string }>(
    "select id, status from southstar.workflow_runs where id = $1",
    [runId],
  );
  const tasks = (await db.query<{
    id: string;
    task_key: string;
    status: string;
    sort_order: number;
    depends_on_json: unknown;
  }>(
    "select id, task_key, status, sort_order, depends_on_json from southstar.workflow_tasks where run_id = $1 order by sort_order, id",
    [runId],
  )).rows;
  const envelopes = (await db.query<{ task_id: string | null; payload_json: unknown }>(
    `select distinct on (task_id) task_id, payload_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'task_envelope' and task_id is not null
      order by task_id, created_at desc, resource_key desc`,
    [runId],
  )).rows;
  const envelopeByTask = new Map(
    envelopes
      .filter((row) => typeof row.task_id === "string")
      .map((row) => [row.task_id as string, asRecord(asRecord(row.payload_json).envelope)]),
  );
  const accepted = await acceptedArtifactTaskIdsForRunPg(db, runId);
  const taskStatusById = new Map(tasks.map((task) => [task.id, task.status]));
  const selectedTaskId = taskId ?? tasks[0]?.id;
  const selectedDefinition = selectedTaskId ? await taskDefinition(db, { runId, taskId: selectedTaskId }) : null;
  return {
    activeDraft: null,
    canvasModel: {
      graphId: run.id,
      mode: "runtime" as const,
      nodes: tasks.map((task) => {
        const envelope = envelopeByTask.get(task.id) ?? {};
        const role = asRecord(envelope.role);
        const profile = asRecord(envelope.agentProfile);
        const artifact = asRecord(envelope.artifactContract);
        return {
          id: task.id,
          label: task.task_key,
          kind: "task" as const,
          status: task.status,
          roleRef: stringValue(role.id),
          agentProfileRef: stringValue(profile.id),
          artifactKind: stringValue(artifact.kind),
          badges: badgesForTask(task.status, {
            roleRef: stringValue(role.id),
            agentProfileRef: stringValue(profile.id),
          }),
        };
      }),
      edges: tasks.flatMap((task) => stringArray(task.depends_on_json).map((source) => ({
        id: `${source}->${task.id}`,
        source,
        target: task.id,
        status: dependencySatisfied(taskStatusById.get(source), accepted.has(source)) ? "satisfied" as const : "pending" as const,
      }))),
      selectedNodeId: selectedTaskId,
    },
    selectedDefinition,
    agentLibrarySummary: null,
    validationIssues: [],
    repairAttempts: [],
    commands: [],
  };
}

async function buildDraftWorkflowModel(db: SouthstarDb, draftId: string, taskId?: string) {
  const draft = await getResourceByKeyPg(db, "planner_draft", draftId);
  if (!draft) throw new Error(`planner draft not found: ${draftId}`);
  const payload = asRecord(draft.payload);
  const workflow = asRecord(payload.workflow);
  const tasks = arrayRecords(workflow.tasks);
  const selectedTask = taskId ? tasks.find((task) => task.id === taskId) : tasks[0];
  return {
    activeDraft: { draftId, workflowId: stringValue(workflow.workflowId), goalPrompt: stringValue(asRecord(draft.summary).goalPrompt) },
    canvasModel: {
      graphId: draftId,
      mode: "draft" as const,
      nodes: tasks.map((task) => ({
        id: requiredString(task.id, "task.id"),
        label: stringValue(task.name) ?? requiredString(task.id, "task.id"),
        kind: "task" as const,
        status: draft.status,
        roleRef: stringValue(task.roleRef),
        agentProfileRef: stringValue(task.agentProfileRef),
        badges: badgesForTask(draft.status, task),
      })),
      edges: tasks.flatMap((task) => stringArray(task.dependsOn).map((source) => ({
        id: `${source}->${String(task.id)}`,
        source,
        target: requiredString(task.id, "task.id"),
        status: "ready" as const,
      }))),
      selectedNodeId: stringValue(selectedTask?.id),
    },
    selectedDefinition: selectedTask ? { taskId: selectedTask.id, task: selectedTask } : null,
    agentLibrarySummary: null,
    validationIssues: arrayRecords(asRecord(draft.summary).validationIssues),
    repairAttempts: arrayRecords(payload.repairAttempts),
    commands: [],
  };
}

async function taskDefinition(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const envelope = await db.maybeOne<{ payload_json: unknown }>(
    `select payload_json from southstar.runtime_resources
      where resource_type = 'task_envelope' and run_id = $1 and task_id = $2
      order by created_at desc, resource_key desc limit 1`,
    [input.runId, input.taskId],
  );
  const payload = asRecord(envelope?.payload_json);
  const env = asRecord(payload.envelope);
  return {
    taskId: input.taskId,
    roleDefinition: env.role,
    agentProfile: env.agentProfile,
    skills: Array.isArray(env.skills) ? env.skills : [],
    materializedLibraryRefs: env.materializedLibraryRefs,
    artifactContract: env.artifactContract,
    evaluatorPipeline: env.evaluatorPipeline,
    contextPolicy: env.contextPolicy,
  };
}

function badgesForTask(status: string, data: Record<string, unknown>) {
  const badges = [{ tone: "status", label: status }];
  const roleRef = stringValue(data.roleRef);
  const agentProfileRef = stringValue(data.agentProfileRef);
  if (roleRef) badges.push({ tone: "role", label: roleRef });
  if (agentProfileRef) badges.push({ tone: "profile", label: agentProfileRef });
  return badges;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function dependencySatisfied(status: string | undefined, accepted: boolean): boolean {
  if (accepted) return true;
  return status === "completed" || status === "passed";
}
