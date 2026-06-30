"use client";

import { useEffect, useRef, useState } from "react";
import { operatorRuntimeEventStreamUrl, parseSseBuffer, runtimeEventFromFrame } from "@/lib/operator/sse";
import type { RuntimeEventItem } from "@/lib/operator/types";

export function useRuntimeEventStream(input: { runId: string | null; taskId?: string | null; scope: "task" | "run" }) {
  const [events, setEvents] = useState<RuntimeEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!input.runId) {
      setEvents([]);
      setError(null);
      return;
    }

    const streamKey = `${input.runId}:${input.scope}:${input.taskId || "all"}`;
    let closed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: number | null = null;

    const connect = async () => {
      controller = new AbortController();
      let buffer = "";
      try {
        const response = await fetch(operatorRuntimeEventStreamUrl({
          runId: input.runId!,
          taskId: input.scope === "task" ? input.taskId : null,
          after: cursorRef.current[streamKey],
          includeRunEvents: input.scope === "task",
        }), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`event stream failed with ${response.status}`);
        if (!response.body) throw new Error("event stream response missing body");
        setError(null);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseBuffer(buffer);
          buffer = parsed.remaining;
          for (const frame of parsed.frames) {
            if (frame.id) cursorRef.current[streamKey] = frame.id;
            const event = runtimeEventFromFrame(frame);
            if (event) setEvents((current) => [event, ...current].slice(0, 200));
          }
        }
      } catch (caught) {
        if (closed || controller?.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!closed) reconnectTimer = window.setTimeout(connect, 1200);
    };

    setEvents([]);
    void connect();
    return () => {
      closed = true;
      controller?.abort();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, [input.runId, input.scope, input.taskId]);

  return { events, error };
}
