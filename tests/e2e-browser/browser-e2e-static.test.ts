import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("browser E2E has a repo-owned real UI runner outside the Postgres matrix", () => {
  const pkg = JSON.parse(source("package.json")) as {
    scripts: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.scripts["test:e2e:browser:07"], "tsx tests/e2e-browser/07-real-ui-postgres-browser.test.ts");
  assert.ok(pkg.devDependencies?.playwright || pkg.devDependencies?.["@playwright/test"]);
  assert.equal(existsSync(join(root, "tests/e2e-browser/07-real-ui-postgres-browser.test.ts")), true);
  assert.equal(existsSync(join(root, "tests/e2e-postgres/ui")), false);
  assert.equal(existsSync(join(root, "tests/e2e-ui")), false);
});

test("real browser E2E drives browser against real Southstar API and Next app", () => {
  const text = source("tests/e2e-browser/07-real-ui-postgres-browser.test.ts");
  assert.match(text, /playwright/);
  assert.match(text, /createSouthstarRuntimeServer|createRealRuntimeServer/);
  assert.match(text, /NEXT_PUBLIC_SOUTHSTAR_SERVER_URL/);
  assert.match(text, /npm run web:dev/);
  assert.match(text, /Chat/);
  assert.match(text, /Workflow/);
  assert.match(text, /Operator/);
  assert.match(text, /getByRole\(["']tab["']|getByRole\(["']button["'][\s\S]*Workflow/);
  assert.match(text, /React Flow|react-flow|ss-workflow-canvas/);
  assert.match(text, /MiniMap|react-flow__minimap|ss-native-minimap/);
  assert.match(text, /viewport|setViewportSize/);
  assert.match(text, /api\/v2\/chat\/sessions|chat-session/);
  assert.match(text, /attention|Intervention/i);
  assert.doesNotMatch(text, /fake|mock|smoke|test-only/i);
});
