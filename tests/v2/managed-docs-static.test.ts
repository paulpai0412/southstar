import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("managed-agent docs include operator procedures and core interfaces", () => {
  const design = readFileSync("docs/superpowers/specs/2026-06-20-southstar-managed-agents-meta-harness-design.zh.md", "utf8");
  const runbook = readFileSync("docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md", "utf8");

  assert.match(design, /SessionStore/);
  assert.match(design, /BrainProvider/);
  assert.match(design, /HandProvider/);
  assert.match(runbook, /brain crash recovery/);
  assert.match(runbook, /hand reprovision/);
  assert.match(runbook, /credential isolation/);
});
