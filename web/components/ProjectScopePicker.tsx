"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { PiAgentTitle } from "./SessionSidebar";

export function ProjectScopePicker({
  selectedCwd,
  onCwdChange,
  label = "Project Scope",
  emptyLabel = "Select project...",
  actions,
}: {
  selectedCwd: string | null;
  onCwdChange: (cwd: string | null) => void;
  label?: string;
  emptyLabel?: string;
  actions?: ReactNode;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [homeDir, setHomeDir] = useState("");
  const [open, setOpen] = useState(false);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/sessions?kind=chat&scope=all&limit=50&compact=1", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { sessions?: SessionInfo[] }) => setSessions(data.sessions || []))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    fetch("/api/home")
      .then((res) => res.json())
      .then((data: { home?: string }) => {
        if (data.home) setHomeDir(data.home);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const recentCwds = useMemo(() => {
    const latestByCwd = new Map<string, string>();
    for (const session of sessions) {
      if (!session.cwd) continue;
      const previous = latestByCwd.get(session.cwd);
      if (!previous || session.modified > previous) latestByCwd.set(session.cwd, session.modified);
    }
    const rows = [...latestByCwd.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 8)
      .map(([cwd]) => cwd);
    return selectedCwd && !rows.includes(selectedCwd) ? [selectedCwd, ...rows] : rows;
  }, [sessions, selectedCwd]);

  const commitCustomPath = useCallback(async () => {
    const cwd = customPathValue.trim();
    if (!cwd) return;
    setCustomPathError(null);
    const res = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json() as { cwd?: string; error?: string };
    if (!res.ok || !data.cwd) {
      setCustomPathError(data.error || "Directory does not exist");
      return;
    }
    onCwdChange(data.cwd);
    setCustomPathValue("");
    setCustomPathOpen(false);
    setOpen(false);
  }, [customPathValue, onCwdChange]);

  return (
    <div data-testid="project-scope-picker" style={{ padding: "12px 10px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
        <PiAgentTitle />
        {actions ?? (
          <span style={{ color: "var(--text-dim)", fontSize: 11, fontWeight: 650, textTransform: "uppercase", whiteSpace: "nowrap" }}>
            {label}
          </span>
        )}
      </div>
      <div ref={ref} style={{ position: "relative" }}>
        <button type="button" onClick={() => setOpen((value) => !value)} className="project-scope-button" title={selectedCwd || ""}>
          {selectedCwd ? shortenCwd(selectedCwd, homeDir) : emptyLabel}
        </button>
        {open ? (
          <div className="project-scope-menu">
            <button type="button" onClick={() => { onCwdChange(null); setOpen(false); }} className="project-scope-menu-item">
              All projects
            </button>
            {recentCwds.map((cwd) => (
              <button key={cwd} type="button" onClick={() => { onCwdChange(cwd); setOpen(false); }} className="project-scope-menu-item" title={cwd}>
                {shortenCwd(cwd, homeDir)}
              </button>
            ))}
            {customPathOpen ? (
              <div style={{ padding: 8, display: "grid", gap: 6 }}>
                <input
                  data-testid="project-scope-custom-path"
                  value={customPathValue}
                  onChange={(event) => setCustomPathValue(event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void commitCustomPath(); }}
                  placeholder="~/apps/southstar-vocab"
                  autoFocus
                />
                <button type="button" onClick={() => void commitCustomPath()}>Use</button>
                {customPathError ? <p className="operator-muted operator-danger">{customPathError}</p> : null}
              </div>
            ) : (
              <button type="button" onClick={() => setCustomPathOpen(true)} className="project-scope-menu-item">
                Choose path...
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function shortenCwd(cwd: string, homeDir?: string): string {
  const path = homeDir && cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join(sep)}`;
}
