import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test.before(() => {
  register(
    "data:text/javascript,export async function load(url, context, nextLoad) { if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' }; return nextLoad(url, context); }",
    import.meta.url,
  );
});

test("OperatorBoard composes workflow-oriented operator surface", () => {
  const board = source("components/southstar/operator/OperatorBoard.tsx");
  assert.match(board, /ActiveRunStrip/);
  assert.match(board, /AttentionQueue/);
  assert.match(board, /onSelectAttention/);
  assert.match(board, /SouthstarWorkflowCanvas/);
  assert.match(board, /workflow-canvas\/SouthstarWorkflowCanvas/);
  assert.match(board, /InterventionPanel/);
  assert.match(board, /targetTaskId/);
  assert.match(board, /targetAttentionId/);
  assert.match(board, /RunEventStreamPanel/);
  assert.match(board, /getUiOperatorOverview/);
  assert.match(board, /getUiWorkflow/);
  assert.match(board, /setSelectedRunId\(attentionRunId\)/);
  assert.match(board, /setSelectedTaskId\(attentionTaskId\)/);
});

test("OperatorBoard preserves runtime canvas overlays from the workflow read model", async () => {
  const operatorModule = await import("../../components/southstar/operator/OperatorBoard.tsx");
  assert.equal(typeof (operatorModule as any).operatorWorkflowCanvasFromReadModel, "function");
  const canvas = (operatorModule as any).operatorWorkflowCanvasFromReadModel({
    canvasModel: {
      graphId: "run-runtime-overlay",
      mode: "runtime",
      selectedNodeId: "task-build",
      nodes: [{
        id: "task-build",
        label: "Build",
        kind: "task",
        status: "running",
        dependsOn: ["task-plan"],
        roleRef: "builder",
        agentProfileRef: "builder-codex",
        badges: [
          { tone: "good", label: "artifact accepted" },
          { tone: "danger", label: "exception observed" },
          { tone: "warn", label: "approval pending" },
          { tone: "warn", label: "recovery proposed" },
        ],
        attention: { severity: "blocked", reason: "Callback missing" },
      }],
      edges: [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "active" }],
    },
  });
  assert.equal(canvas.graphId, "run-runtime-overlay");
  assert.equal(canvas.mode, "runtime");
  assert.equal(canvas.selectedNodeId, "task-build");
  assert.deepEqual(canvas.nodes[0]?.badges.map((badge: { label: string }) => badge.label), [
    "artifact accepted",
    "exception observed",
    "approval pending",
    "recovery proposed",
  ]);
  assert.deepEqual(canvas.nodes[0]?.attention, { severity: "blocked", reason: "Callback missing" });
  assert.deepEqual(canvas.edges, [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "active" }]);
});

test("Run Workflow handoff passes the newly created run into Operator selection", async () => {
  const operatorModule = await import("../../components/southstar/operator/OperatorBoard.tsx");
  assert.equal(typeof (operatorModule as any).selectInitialOperatorRunId, "function");
  assert.equal(typeof (operatorModule as any).operatorTargetsAfterRunSelection, "function");
  assert.equal(
    (operatorModule as any).selectInitialOperatorRunId(
      [{ runId: "run-old" }, { runId: "run-new" }],
      "run-old",
      "run-new",
    ),
    "run-new",
  );
  assert.equal(
    (operatorModule as any).selectInitialOperatorRunId(
      [{ runId: "run-old" }],
      "run-old",
      "run-new",
    ),
    "run-new",
  );

  const shell = source("components/southstar/app/SouthstarPiWebShell.tsx");
  assert.match(shell, /operatorRunId/);
  assert.match(shell, /<OperatorBoard[^>]*selectedRunId=\{operatorRunId\}/s);

  const board = source("components/southstar/operator/OperatorBoard.tsx");
  assert.match(board, /operatorTargetsAfterRunSelection\(\{\s*currentRunId:\s*selectedRunId,\s*nextRunId:\s*props\.selectedRunId/s);
});

test("OperatorBoard clears task and attention targets when the selected run changes", async () => {
  const operatorModule = await import("../../components/southstar/operator/OperatorBoard.tsx");
  assert.equal(typeof (operatorModule as any).operatorTargetsAfterRunSelection, "function");
  assert.deepEqual(
    (operatorModule as any).operatorTargetsAfterRunSelection({
      currentRunId: "run-old",
      nextRunId: "run-new",
      selectedTaskId: "selected-task-from-old-run",
      targetTaskId: "task-from-old-run",
      targetAttentionId: "attention-from-old-run",
    }),
    { selectedTaskId: null, targetTaskId: null, targetAttentionId: null },
  );
  assert.deepEqual(
    (operatorModule as any).operatorTargetsAfterRunSelection({
      currentRunId: "run-new",
      nextRunId: "run-new",
      selectedTaskId: "selected-task-from-new-run",
      targetTaskId: "task-from-new-run",
      targetAttentionId: "attention-from-new-run",
    }),
    {
      selectedTaskId: "selected-task-from-new-run",
      targetTaskId: "task-from-new-run",
      targetAttentionId: "attention-from-new-run",
    },
  );
});

test("OperatorBoard ignores stale workflow canvas while a prop-selected run is loading", async () => {
  const operatorModule = await import("../../components/southstar/operator/OperatorBoard.tsx");
  assert.equal(typeof (operatorModule as any).operatorWorkflowCanvasForSelectedRun, "function");
  const canvas = (operatorModule as any).operatorWorkflowCanvasForSelectedRun({
    canvasModel: {
      graphId: "run-old",
      mode: "runtime",
      selectedNodeId: "task-old",
      nodes: [{ id: "task-old", label: "Old task", kind: "task", status: "running", dependsOn: [], badges: [] }],
      edges: [],
    },
  }, "run-new");
  assert.deepEqual(canvas, {
    graphId: "run-new",
    mode: "runtime",
    selectedNodeId: null,
    nodes: [],
    edges: [],
  });

  const board = source("components/southstar/operator/OperatorBoard.tsx");
  assert.match(board, /operatorWorkflowCanvasForSelectedRun\(workflow\.model,\s*selectedRunId\)/);
});

test("AttentionQueue supports click-through selection payload", () => {
  const queue = source("components/southstar/operator/AttentionQueue.tsx");
  assert.match(queue, /onSelectAttention/);
  assert.match(queue, /runId\?: string/);
  assert.match(queue, /taskId\?: string/);
  assert.match(queue, /<button/);
  assert.match(queue, /onClick=\{\(\) => props\.onSelectAttention\?\.\(item\)\}/);
});

test("InterventionPanel enforces confirmation with reason and forwards reason", () => {
  const panel = source("components/southstar/operator/InterventionPanel.tsx");
  assert.match(panel, /\bcommands\b/);
  assert.match(panel, /requiresConfirmation/);
  assert.match(panel, /reason/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /onInvokeCommand: \(command: OperatorCommand, reason\?: string\)/);
  assert.match(panel, /await props\.onInvokeCommand\(command, reason\)/);
  assert.match(panel, /disabledReason/);
});

test("operator commands use unique runtime command ids and do not render inert GET commands", () => {
  const board = source("components/southstar/operator/OperatorBoard.tsx");
  const overview = source("src/v2/read-models/operator-overview.ts");

  assert.match(board, /createOperatorCommandRequestId/);
  assert.match(board, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(board, /commandId: `ui:\$\{command\.id\}:\$\{targetAttentionId/);
  assert.doesNotMatch(overview, /command\("exception\.open",\s*"Open Exception"[\s\S]*method:\s*"GET"/);
});

test("OperatorBoard opens selected attention in the matching intervention mode", () => {
  const board = source("components/southstar/operator/OperatorBoard.tsx");
  assert.match(board, /selectedAttention/);
  assert.match(board, /interventionMode=\{selectedAttention\?\.interventionMode/);
  assert.match(board, /commands=\{commands\}/);
  assert.match(board, /commandResults=\{commandResults\}/);

  const queue = source("components/southstar/operator/AttentionQueue.tsx");
  assert.match(queue, /interventionMode\?: string/);

  const panel = source("components/southstar/operator/InterventionPanel.tsx");
  assert.match(panel, /interventionMode/);
  assert.match(panel, /commandResults/);
});

test("RunEventStreamPanel reconnects with cursor semantics after stream errors", () => {
  const stream = source("components/southstar/operator/RunEventStreamPanel.tsx");
  const board = source("components/southstar/operator/OperatorBoard.tsx");
  const shell = source("components/southstar/app/SouthstarPiWebShell.tsx");

  assert.match(stream, /serverBaseUrl/);
  assert.match(stream, /events\/stream/);
  assert.match(stream, /after=/);
  assert.match(stream, /\bfetch\b/);
  assert.match(stream, /ReadableStreamDefaultReader/);
  assert.match(stream, /parseSseBuffer/);
  assert.match(stream, /lastEventIdByRunRef/);
  assert.match(stream, /lastEventIdByRunRef\.current\[runId\]/);
  assert.match(stream, /setTimeout/);
  assert.match(stream, /reconnect/i);
  assert.match(board, /RunEventStreamPanel runId=\{selectedRunId\} serverBaseUrl=\{props\.serverBaseUrl\}/);
  assert.match(shell, /<OperatorBoard[^>]*serverBaseUrl=\{baseUrl\}/s);
});

test("RunEventStreamPanel parses arbitrary named SSE frames and scopes cursor per run", async () => {
  const streamModule = await import("../../components/southstar/operator/RunEventStreamPanel.tsx");
  assert.equal(typeof (streamModule as any).parseSseBuffer, "function");
  assert.equal(typeof (streamModule as any).runtimeEventStreamUrl, "function");
  const parsed = (streamModule as any).parseSseBuffer([
    "id: 7",
    "event: recovery_decision.operator_decided",
    "data: {\"eventType\":\"recovery_decision.operator_decided\",\"message\":\"approved\"}",
    "",
    "id: 8",
    "event: progress.commentary",
    "data: {\"eventType\":\"progress.commentary\",\"summary\":\"working\"}",
    "",
    "id: 9",
    "event: artifact.created",
    "data: {\"eventType\":\"artifact.created\",\"payload\":{\"path\":\"out.txt\"}}",
    "",
    "",
  ].join("\n"));
  assert.deepEqual(parsed.frames.map((frame: { eventType: string; id?: string }) => `${frame.id}:${frame.eventType}`), [
    "7:recovery_decision.operator_decided",
    "8:progress.commentary",
    "9:artifact.created",
  ]);
  assert.equal(parsed.remaining, "");
  assert.equal(
    (streamModule as any).runtimeEventStreamUrl("http://127.0.0.1:3001/", "run-new", undefined),
    "http://127.0.0.1:3001/api/v2/runs/run-new/events/stream?closeOnTerminal=false",
  );
  assert.equal(
    (streamModule as any).runtimeEventStreamUrl("http://127.0.0.1:3001", "run-old", "42"),
    "http://127.0.0.1:3001/api/v2/runs/run-old/events/stream?closeOnTerminal=false&after=42",
  );
});
