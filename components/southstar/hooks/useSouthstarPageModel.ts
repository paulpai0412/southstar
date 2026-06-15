"use client";

import { useEffect, useState } from "react";

export function useSouthstarPageModel<T>(loader: () => Promise<T>, deps: React.DependencyList = []) {
  const [model, setModel] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function refresh() {
    setPending(true);
    setError(null);
    try {
      setModel(await loader());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(false);
    }
  }
  useEffect(() => { void refresh(); }, deps);
  return { model, error, pending, refresh };
}
