import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("web root route uses the AppShell entry and keeps legacy planner page source available", () => {
  const route = readFileSync(join(root, "web/app/page.tsx"), "utf8");
  const shell = readFileSync(join(root, "components/southstar/shell/SideRail.tsx"), "utf8");
  const page = readFileSync(join(root, "components/southstar/pages/PlannerPage.tsx"), "utf8");
  assert.match(route, /AppShell/);
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

test("legacy 1:1 shared UI primitives still exist while web owns the route entry", () => {
  for (const component of ["Button", "Panel", "StatusBadge", "DataTable", "MetricCard", "Timeline", "CodeBlock", "GraphCanvas"]) {
    const source = readFileSync(join(root, `components/southstar/ui/${component}.tsx`), "utf8");
    assert.match(source, new RegExp(`export function ${component}`));
  }
  const css = readFileSync(join(root, "web/app/globals.css"), "utf8");
  assert.match(css, /--bg\b/);
  assert.match(css, /--bg-panel\b/);
  assert.match(css, /border-radius: [5-8]px/);
});

test("web AppShell exposes Chat Workflow Operator tabs", () => {
  const route = readFileSync(join(root, "web/app/page.tsx"), "utf8");
  const rail = readFileSync(join(root, "web/components/AppModeRail.tsx"), "utf8");
  assert.match(route, /AppShell/);
  assert.match(rail, /\bchat\b/);
  assert.match(rail, /\bworkflow\b/);
  assert.match(rail, /\boperator\b/);
});
