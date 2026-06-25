import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("operator board shows active runs, attention queue, runtime canvas, and intervention panel", () => {
  const board = source("components/southstar/operator/OperatorBoard.tsx");
  assert.match(board, /ActiveRunStrip/);
  assert.match(board, /AttentionQueue/);
  assert.match(board, /SouthstarWorkflowCanvas/);
  assert.match(board, /InterventionPanel/);
  assert.match(board, /getUiOperatorOverview/);
  assert.match(board, /getUiWorkflow/);
});

test("intervention panel uses command affordance endpoints and event stream", () => {
  const panel = source("components/southstar/operator/InterventionPanel.tsx");
  const stream = source("components/southstar/operator/RunEventStreamPanel.tsx");
  assert.match(panel, /commands/);
  assert.match(panel, /requiresConfirmation/);
  assert.match(panel, /disabledReason/);
  assert.match(stream, /events\/stream/);
  assert.match(stream, /EventSource/);
});
