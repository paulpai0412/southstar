"use client";

import { useEffect, useState } from "react";

export function useRunEvents(input: { baseUrl: string; runId?: string | null }) {
  const [events, setEvents] = useState<unknown[]>([]);
  useEffect(() => {
    if (!input.runId) return;
    let cancelled = false;
    async function poll() {
      const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/api/v2/runs/${encodeURIComponent(input.runId!)}/events`);
      const body = await response.json() as { result?: unknown[] };
      if (!cancelled) setEvents(body.result ?? []);
    }
    void poll();
    const interval = setInterval(() => void poll(), 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [input.baseUrl, input.runId]);
  return events;
}
