import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function hasCssVariable(css: string, variable: string): boolean {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*:`, "m").test(css);
}

test("app root references SouthstarPiWebShell", () => {
  assert.match(source("app/page.tsx"), /SouthstarPiWebShell/);
});

test("SouthstarPiWebShell composes SessionSidebar ChatWindow and FileViewer", () => {
  const shell = source("components/southstar/app/SouthstarPiWebShell.tsx");
  assert.match(shell, /SessionSidebar/);
  assert.match(shell, /ChatWindow/);
  assert.match(shell, /FileViewer/);
});

test("WorkspaceTabs uses Chat Workflow Operator and removes legacy labels", () => {
  const tabs = source("components/southstar/workspace/WorkspaceTabs.tsx");
  assert.match(tabs, /\bChat\b/);
  assert.match(tabs, /\bWorkflow\b/);
  assert.match(tabs, /\bOperator\b/);
  assert.doesNotMatch(tabs, /Operations|Northstar/);
});

test("css variable matcher requires exact --bg declaration instead of substring match", () => {
  const css = ":root { --bg-panel: #111; }";
  assert.equal(hasCssVariable(css, "--bg"), false);
});

test("globals.css contains pi-web tokens and dark mode selector", () => {
  const css = source("app/globals.css");
  assert.ok(hasCssVariable(css, "--bg"), "missing --bg");
  assert.ok(hasCssVariable(css, "--bg-panel"), "missing --bg-panel");
  assert.ok(hasCssVariable(css, "--bg-hover"), "missing --bg-hover");
  assert.ok(hasCssVariable(css, "--bg-selected"), "missing --bg-selected");
  assert.ok(hasCssVariable(css, "--accent"), "missing --accent");
  assert.ok(css.includes("html.dark"), "missing html.dark");
});
