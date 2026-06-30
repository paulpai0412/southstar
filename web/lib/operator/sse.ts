import type { RuntimeEventItem } from "./types";

type SseFrame = {
  id?: string;
  eventType: string;
  data: string;
};

export function operatorRuntimeEventStreamUrl(input: { runId: string; taskId?: string | null; after?: string | null; includeRunEvents?: boolean }): string {
  const params = new URLSearchParams({ closeOnTerminal: "false" });
  if (input.taskId) params.set("taskId", input.taskId);
  if (input.after) params.set("after", input.after);
  if (input.includeRunEvents === false) params.set("includeRunEvents", "false");
  return `/api/operator/runs/${encodeURIComponent(input.runId)}/events/stream?${params.toString()}`;
}

export function parseSseBuffer(buffer: string): { frames: SseFrame[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remaining = parts.pop() || "";
  return {
    frames: parts.map(parseSseFrame).filter((frame): frame is SseFrame => frame !== null),
    remaining,
  };
}

export function runtimeEventFromFrame(frame: SseFrame): RuntimeEventItem | null {
  if (frame.eventType === "heartbeat") return null;
  try {
    const parsed = JSON.parse(frame.data) as Record<string, unknown>;
    const sequence = typeof parsed.sequence === "number" ? parsed.sequence : undefined;
    return {
      id: frame.id || (sequence !== undefined ? String(sequence) : `${Date.now()}`),
      sequence,
      eventType: stringValue(parsed.eventType) || frame.eventType,
      runId: stringValue(parsed.runId),
      taskId: stringValue(parsed.taskId),
      text: eventText(parsed, frame.data),
      payload: parsed.payload,
      createdAt: stringValue(parsed.createdAt),
    };
  } catch {
    return {
      id: frame.id || `${Date.now()}`,
      eventType: frame.eventType,
      text: frame.data,
    };
  }
}

function parseSseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) eventType = line.slice(6).trimStart();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0 && eventType === "message" && !id) return null;
  return { ...(id ? { id } : {}), eventType, data: dataLines.join("\n") };
}

function eventText(parsed: Record<string, unknown>, fallback: string): string {
  const payload = parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
    ? parsed.payload as Record<string, unknown>
    : {};
  return stringValue(parsed.message)
    || stringValue(parsed.summary)
    || stringValue(payload.message)
    || stringValue(payload.summary)
    || fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
