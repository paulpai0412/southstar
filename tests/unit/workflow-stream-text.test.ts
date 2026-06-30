import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWorkflowStreamText,
  normalizeWorkflowStreamText,
} from "../../web/lib/workflow/stream-text.ts";

test("workflow stream text appends message deltas without losing later normalization", () => {
  let raw = "";
  raw = appendWorkflowStreamText(raw, "生成 workflow DAG", "message.delta");
  raw = appendWorkflowStreamText(raw, "。接著建立任務。", "message.delta");

  assert.equal(
    normalizeWorkflowStreamText(raw),
    "生成 workflow DAG。\n\n接著建立任務。"
  );
});

test("workflow stream text renders complete JSON as a readable fenced block", () => {
  const raw = appendWorkflowStreamText(
    "",
    '{"workflowId":"todo","tasks":[{"id":"frontend","dependsOn":[]},{"id":"api","dependsOn":[]}]}',
    "message.delta"
  );

  assert.equal(
    normalizeWorkflowStreamText(raw),
    [
      "```json",
      "{",
      '  "workflowId": "todo",',
      '  "tasks": [',
      "    {",
      '      "id": "frontend",',
      '      "dependsOn": []',
      "    },",
      "    {",
      '      "id": "api",',
      '      "dependsOn": []',
      "    }",
      "  ]",
      "}",
      "```",
    ].join("\n")
  );
});

test("workflow stream text renders embedded compact JSON as a readable fenced block", () => {
  const raw = appendWorkflowStreamText(
    "",
    'Planner output: {"workflowId":"todo","tasks":[{"id":"frontend"},{"id":"api"}]}',
    "message.delta"
  );

  assert.equal(
    normalizeWorkflowStreamText(raw),
    [
      "Planner output:",
      "",
      "```json",
      "{",
      '  "workflowId": "todo",',
      '  "tasks": [',
      "    {",
      '      "id": "frontend"',
      "    },",
      "    {",
      '      "id": "api"',
      "    }",
      "  ]",
      "}",
      "```",
    ].join("\n")
  );
});

test("workflow stream text keeps stage lines readable around message deltas", () => {
  let raw = "";
  raw = appendWorkflowStreamText(raw, "[planning] Building graph", "line");
  raw = appendWorkflowStreamText(raw, "已建立需求節點。", "message.delta");
  raw = appendWorkflowStreamText(raw, "[draft] draft-123 validated", "line");

  assert.equal(
    normalizeWorkflowStreamText(raw),
    "[planning] Building graph\n\n已建立需求節點。\n\n[draft] draft-123 validated"
  );
});
