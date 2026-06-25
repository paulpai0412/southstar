import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const CORE_FILES = [
  "src/v2/context/managed-context-assembler.ts",
  "src/v2/scheduler/runnable-task-scheduler.ts",
  "src/v2/exceptions/runtime-exception-controller.ts",
  "src/v2/exceptions/recovery-decision-applier.ts",
  "src/v2/evolution/sandbox.ts",
];

test("core runtime files do not import software domain pack directly", () => {
  const offenders = CORE_FILES.filter((file) => source(file).includes("../domain-packs/software.ts"));
  assert.deepEqual(offenders, []);
});

test("manifest types do not make tork the only execution engine", () => {
  const text = source("src/v2/manifests/types.ts");
  assert.equal(text.includes('engine: "tork";'), false);
});

test("generic workflow generator does not emit calc fixture task id", () => {
  const text = source("src/v2/workflow-generator/constrained-generator.ts");
  assert.equal(text.includes("implement-calc-command"), false);
});

test("current postgres state model documentation names layered canonical tables", () => {
  const text = source("docs/superpowers/southstar-current-postgres-state-model.md");
  for (const table of ["work_items", "workflow_runs", "workflow_tasks", "workflow_history", "runtime_resources"]) {
    assert.match(text, new RegExp(`\\b${table}\\b`));
  }
  assert.match(text, /layered state model/i);
});

function source(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}
