import type { HistoryEntry, RuntimeEffect } from "../types/control-plane.ts";

export function effectResultHistory(effect: RuntimeEffect, status: string): HistoryEntry {
  return {
    event_type: "effect_result",
    payload: {
      idempotency_key: effect.idempotency_key,
      effect_type: effect.type,
      status,
    },
  };
}
