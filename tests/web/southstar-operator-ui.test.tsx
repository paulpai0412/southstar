import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

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

test("RunEventStreamPanel reconnects with cursor semantics after stream errors", () => {
  const stream = source("components/southstar/operator/RunEventStreamPanel.tsx");
  assert.match(stream, /events\/stream/);
  assert.match(stream, /after=/);
  assert.match(stream, /\bEventSource\b/);
  assert.match(stream, /lastEventId/);
  assert.match(stream, /setTimeout/);
  assert.match(stream, /reconnect/i);
});
