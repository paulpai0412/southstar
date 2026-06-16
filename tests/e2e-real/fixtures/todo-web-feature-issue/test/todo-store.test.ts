import assert from "node:assert/strict";
import test from "node:test";
import { createTodo, deleteTodo, filterTodos, parseTodos, serializeTodos, toggleTodo } from "../src/todo-store.ts";

test("creates, toggles, filters, deletes, and serializes todos", () => {
  const first = createTodo("Write E2E", new Date("2026-06-15T00:00:00.000Z"));
  const second = createTodo("Review evidence", new Date("2026-06-15T00:01:00.000Z"));
  const toggled = toggleTodo([first, second], first.id);
  assert.equal(toggled[0]?.completed, true);
  assert.deepEqual(filterTodos(toggled, "completed").map((todo) => todo.text), ["Write E2E"]);
  assert.deepEqual(deleteTodo(toggled, second.id).map((todo) => todo.text), ["Write E2E"]);
  assert.deepEqual(parseTodos(serializeTodos(toggled)).map((todo) => todo.text), ["Write E2E", "Review evidence"]);
});
