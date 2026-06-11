import type { HistoryEntry } from "../types/control-plane.ts";
import type { RuntimeEvent } from "./state-machine.ts";

export function eventsFromHistory(history: HistoryEntry[]): RuntimeEvent[] {
  return history
    .filter((entry) => entry.event_type === "runtime_event")
    .map((entry) => entry.payload as RuntimeEvent);
}
