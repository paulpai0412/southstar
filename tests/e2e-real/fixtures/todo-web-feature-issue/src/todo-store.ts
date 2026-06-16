export function createTodo(text, now = new Date()) {
  const trimmed = `${text}`.trim();
  if (!trimmed) throw new Error("Todo text is required");
  return {
    id: `todo-${now.getTime()}-${Math.random().toString(16).slice(2)}`,
    text: trimmed,
    completed: false,
    createdAt: now.toISOString(),
  };
}

export function toggleTodo(todos, id) {
  return todos.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo));
}

export function deleteTodo(todos, id) {
  return todos.filter((todo) => todo.id !== id);
}

export function filterTodos(todos, filter) {
  if (filter === "active") return todos.filter((todo) => !todo.completed);
  if (filter === "completed") return todos.filter((todo) => todo.completed);
  return todos;
}

export function serializeTodos(todos) {
  return JSON.stringify(todos);
}

export function parseTodos(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((todo) => (
      typeof todo?.id === "string"
      && typeof todo?.text === "string"
      && typeof todo?.completed === "boolean"
    ));
  } catch {
    return [];
  }
}
