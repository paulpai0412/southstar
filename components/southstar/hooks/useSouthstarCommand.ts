"use client";

import { useState } from "react";

export function useSouthstarCommand() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function execute<T>(command: () => Promise<T>): Promise<T | null> {
    setPending(true);
    setError(null);
    try {
      return await command();
    } catch (caught) {
      setError((caught as Error).message);
      return null;
    } finally {
      setPending(false);
    }
  }
  return { execute, pending, error };
}
