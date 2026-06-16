import type { SouthstarDb } from "../stores/sqlite.ts";
import { envelopeReadModel, type ReadModelEnvelope } from "./envelope.ts";
import { buildExecutorOpsData } from "./executor-ops.ts";
import { buildRunInspectionData } from "./run-inspection.ts";
import { buildRuntimeMonitorData } from "./runtime-monitor.ts";
import { buildSessionsMemoryData } from "./sessions-memory.ts";
import { buildTaskDetailData } from "./task-detail.ts";
import type { ReadModelInput, ReadModelKind } from "./types.ts";
import { buildVaultMcpData } from "./vault-mcp.ts";
import { buildWorkflowCanvasData } from "./workflow-canvas.ts";

export function buildReadModel(db: SouthstarDb, input: ReadModelInput): ReadModelEnvelope<string, unknown> {
  switch (input.kind) {
    case "run-inspection":
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.run_inspection.v1",
        kind: input.kind,
        data: buildRunInspectionData(db, input.runId),
      });
    case "runtime-monitor":
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.runtime_monitor.v1",
        kind: input.kind,
        data: buildRuntimeMonitorData(db, input.runId),
      });
    case "workflow-canvas":
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.workflow_canvas.v1",
        kind: input.kind,
        data: buildWorkflowCanvasData(db, input.runId),
      });
    case "executor-ops":
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.executor_ops.v1",
        kind: input.kind,
        data: buildExecutorOpsData(db, input.runId),
      });
    case "task-detail": {
      if (!input.taskId) throw new Error("taskId is required for task-detail read model");
      const data = buildTaskDetailData(db, input.runId, input.taskId);
      if (!data) throw new Error(`task not found: ${input.runId}/${input.taskId}`);
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.task_detail.v1",
        kind: input.kind,
        data,
      });
    }
    case "sessions-memory":
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.sessions_memory.v1",
        kind: input.kind,
        data: buildSessionsMemoryData(db, input.runId),
      });
    case "vault-mcp":
      return envelopeReadModel({
        schemaVersion: "southstar.read_model.vault_mcp.v1",
        kind: input.kind,
        data: buildVaultMcpData(db, input.runId),
      });
    default:
      throw new Error(`unknown read model kind: ${String((input as { kind?: ReadModelKind }).kind ?? "missing")}`);
  }
}
