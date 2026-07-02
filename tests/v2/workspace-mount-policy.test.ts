import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { assertWorkspaceMountAllowed, isSouthstarProjectPath, protectedSouthstarRoots } from "../../src/v2/workspace/workspace-mount-policy.ts";

test("workspace mount policy rejects the Southstar project root and children", () => {
  const projectRoot = protectedSouthstarRoots()[0]!;
  assert.equal(isSouthstarProjectPath(projectRoot), true);
  assert.equal(isSouthstarProjectPath(join(projectRoot, "web")), true);
  assert.throws(
    () => assertWorkspaceMountAllowed(projectRoot),
    /refusing to mount Southstar project as workspace repo/,
  );
});

test("workspace mount policy allows external consumer repositories", () => {
  assert.equal(isSouthstarProjectPath("/home/timmypai/apps/customer-todo-web"), false);
  assert.doesNotThrow(() => assertWorkspaceMountAllowed("/home/timmypai/apps/customer-todo-web"));
});
