import type { LibrarySseFrame } from "./types";

export function parseLibrarySseFrames(buffer: string): LibrarySseFrame[] {
  return buffer
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
      const rawData = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      return { event, data: rawData ? JSON.parse(rawData) as Record<string, unknown> : {} };
    });
}

export async function runLibraryChatCommand(input: {
  prompt: string;
  scope: string;
  onFrame: (frame: LibrarySseFrame) => void;
  onAccepted?: (sessionId: string, actionId: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const accepted = await fetch("/api/library/chat/messages", {
    method: "POST",
    signal: input.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: input.prompt, scope: input.scope }),
  });
  if (!accepted.ok) throw new Error(await accepted.text());
  const body = await accepted.json() as { result?: { sessionId?: string; actionId?: string } };
  const sessionId = body.result?.sessionId;
  const actionId = body.result?.actionId;
  if (!sessionId || !actionId) throw new Error("library chat accepted response missing sessionId/actionId");
  input.onAccepted?.(sessionId, actionId);

  const response = await fetch(`/api/library/chat/events?sessionId=${encodeURIComponent(sessionId)}&actionId=${encodeURIComponent(actionId)}`, {
    signal: input.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok) throw new Error(await response.text());
  if (!response.body) throw new Error("library chat event stream missing body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = parts.pop() ?? "";
        for (const frame of parts) {
          for (const parsed of parseLibrarySseFrames(`${frame}\n\n`)) {
            input.onFrame(parsed);
            throwIfLibraryError(parsed);
          }
        }
      }
      if (done) break;
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      for (const parsed of parseLibrarySseFrames(`${trailing}\n\n`)) {
        input.onFrame(parsed);
        throwIfLibraryError(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function throwIfLibraryError(frame: LibrarySseFrame): void {
  if (frame.event !== "library.error") return;
  const message = typeof frame.data.message === "string" ? frame.data.message : "library candidate install failed";
  throw new Error(message);
}

export async function runLibraryCandidateInstallCommand(input: {
  draftId: string;
  selectedCandidateIds: string[];
  selectedEdgeIds?: string[];
  actor?: string;
  reason: string;
  onFrame: (frame: LibrarySseFrame) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(`/api/library/import-drafts/${encodeURIComponent(input.draftId)}/install/stream`, {
    method: "POST",
    signal: input.signal,
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      selectedCandidateIds: input.selectedCandidateIds,
      ...(input.selectedEdgeIds && input.selectedEdgeIds.length > 0 ? { selectedEdgeIds: input.selectedEdgeIds } : {}),
      actor: input.actor,
      reason: input.reason,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  if (!response.body) throw new Error("library candidate install stream missing body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = parts.pop() ?? "";
        for (const frame of parts) {
          for (const parsed of parseLibrarySseFrames(`${frame}\n\n`)) {
            input.onFrame(parsed);
            throwIfLibraryError(parsed);
          }
        }
      }
      if (done) break;
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      for (const parsed of parseLibrarySseFrames(`${trailing}\n\n`)) {
        input.onFrame(parsed);
        throwIfLibraryError(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
