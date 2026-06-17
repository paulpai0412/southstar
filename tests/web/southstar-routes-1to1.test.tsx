import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("planner route uses the 1:1 shell and planner page component", () => {
  const route = readFileSync(join(root, "app/planner/page.tsx"), "utf8");
  const shell = readFileSync(join(root, "components/southstar/shell/SideRail.tsx"), "utf8");
  const page = readFileSync(join(root, "components/southstar/pages/PlannerPage.tsx"), "utf8");
  assert.match(route, /PlannerPage/);
  assert.match(shell, /Planner Chat/);
  assert.match(shell, /Workflow Canvas/);
  assert.match(shell, /Runtime Monitor/);
  assert.match(page, /Run Readiness/);
  assert.match(page, /Task Assignment/);
  assert.match(page, /Context Budget Preview/);
  assert.match(page, /Artifact Contract/);
  assert.match(page, /Stop Condition/);
  assert.doesNotMatch(page, /const .* = \[/);
});

test("legacy 1:1 routes and shared UI primitives still exist", () => {
  for (const route of ["planner", "runtime", "task", "sessions", "worktree", "executor", "domain-packs", "governance"]) {
    const source = readFileSync(join(root, `app/${route}/page.tsx`), "utf8");
    assert.match(source, /Page|PlannerPage|RuntimeMonitorPage|TaskDetailPage|SessionsMemoryPage|WorktreeConsolePage|ExecutorOpsPage|DomainPacksAgentStudioPage|GovernancePage/);
  }
  for (const component of ["Button", "Panel", "StatusBadge", "DataTable", "MetricCard", "Timeline", "CodeBlock", "GraphCanvas"]) {
    const source = readFileSync(join(root, `components/southstar/ui/${component}.tsx`), "utf8");
    assert.match(source, new RegExp(`export function ${component}`));
  }
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(css, /#071827/);
  assert.match(css, /#f7f9fc/);
  assert.match(css, /border-radius: 8px/);
});

test("product shell routes map to SouthstarProductShell tabs", () => {
  for (const route of ["page", "chat/page", "workflow/page", "operations/page"]) {
    const source = readFileSync(join(root, `app/${route}.tsx`), "utf8");
    assert.match(source, /SouthstarProductShell/);
  }
});
