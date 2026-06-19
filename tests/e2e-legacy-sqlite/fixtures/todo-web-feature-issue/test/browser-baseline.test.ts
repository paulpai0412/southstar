import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("baseline page wires todo form and module entry", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-testid="todo-form"/);
  assert.match(html, /data-testid="todo-input"/);
  assert.match(html, /data-testid="todo-list"/);
  assert.match(html, /src="\.\/src\/app\.ts"/);
});
