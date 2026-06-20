import { createTodo, deleteTodo, filterTodos, parseTodos, serializeTodos, toggleTodo } from "./todo-store.ts";

const storageKey = "southstar.todo-web.todos";
let todos = parseTodos(window.localStorage.getItem(storageKey));
let filter = "all";

const form = document.querySelector('[data-testid="todo-form"]');
const input = document.querySelector('[data-testid="todo-input"]');
const list = document.querySelector('[data-testid="todo-list"]');

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    todos = [...todos, createTodo(input?.value ?? "")];
    if (input) input.value = "";
    persistAndRender();
  } catch (error) {
    console.error(error);
  }
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    const next = button.getAttribute("data-filter");
    if (!next) return;
    filter = next;
    render();
  });
});

function persistAndRender() {
  window.localStorage.setItem(storageKey, serializeTodos(todos));
  render();
}

function render() {
  if (!list) return;
  const nodes = filterTodos(todos, filter).map((todo) => renderTodo(todo));
  list.replaceChildren(...nodes);
}

function renderTodo(todo) {
  const item = document.createElement("li");
  item.className = `todo-item${todo.completed ? " completed" : ""}`;
  item.dataset.todoId = todo.id;
  item.innerHTML = `
    <label class="todo-main">
      <input data-testid="toggle-todo" type="checkbox" ${todo.completed ? "checked" : ""} />
      <span class="todo-text">${escapeHtml(todo.text)}</span>
    </label>
    <button data-testid="delete-todo" type="button">Delete</button>
  `;

  item.querySelector('[data-testid="toggle-todo"]')?.addEventListener("change", () => {
    todos = toggleTodo(todos, todo.id);
    persistAndRender();
  });

  item.querySelector('[data-testid="delete-todo"]')?.addEventListener("click", () => {
    todos = deleteTodo(todos, todo.id);
    persistAndRender();
  });

  return item;
}

function escapeHtml(value) {
  return `${value}`.replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
}

render();
