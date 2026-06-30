"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizeOperatorOverview } from "@/lib/operator/normalizers";
import { attentionMatchesRuns, runMatchesCwd } from "@/lib/operator/progress";
import type { OperatorOverview } from "@/lib/operator/types";

const emptyOperatorOverview: OperatorOverview = {
  runs: [],
  attentionItems: [],
  commandResults: [],
  runtimeHealth: { activeRunCount: 0, attentionCount: 0, blockedCount: 0 },
  defaultSelection: null,
};

export function useOperatorOverview(cwd: string | null, enabled = true) {
  const [model, setModel] = useState<OperatorOverview>(emptyOperatorOverview);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch("/api/operator/overview", { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        setModel(normalizeOperatorOverview(data));
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => controller.abort();
  }, [enabled, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return useMemo(() => {
    const runs = model.runs.filter((run) => runMatchesCwd(run, cwd));
    return {
      model: {
        ...model,
        runs,
        attentionItems: model.attentionItems.filter((item) => attentionMatchesRuns(item, runs)),
      },
      error,
      refresh,
    };
  }, [cwd, error, model, refresh]);
}
