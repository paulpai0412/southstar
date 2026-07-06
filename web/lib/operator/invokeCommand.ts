import type { OperatorCommand } from "./types";

export async function invokeOperatorCommand(input: {
  command: OperatorCommand;
  runId: string | null;
  taskId?: string | null;
  reason?: string;
}): Promise<void> {
  const { command, runId, taskId, reason } = input;
  if (!command.endpoint || !command.enabled) return;
  const method = command.method || "POST";
  if (method !== "POST") throw new Error(`${command.label} uses unsupported method ${method}`);
  const payload = {
    ...(command.body || {}),
    runId,
    taskId,
    commandId: `ui:${command.id}:${Date.now()}:${crypto.randomUUID()}`,
    actor: { type: "user", id: "operator-ui" },
    ...(reason ? { reason } : {}),
  };
  const response = await fetch("/api/operator/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: command.endpoint,
      method,
      payload,
    }),
  });
  if (!response.ok) throw new Error(`${command.label} failed with ${response.status}`);
  const result = await response.json() as { result?: { accepted?: unknown; message?: unknown }; accepted?: unknown; message?: unknown };
  const accepted = typeof result.result?.accepted === "boolean" ? result.result.accepted : result.accepted;
  if (accepted !== true) {
    const message = typeof result.result?.message === "string" ? result.result.message : typeof result.message === "string" ? result.message : "command was not accepted";
    throw new Error(message);
  }
}
