"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { FileExplorer } from "./FileExplorer";

const EXPLORER_SPLIT_STORAGE_KEY = "pi-web.sidebarExplorerRatio";
const EXPLORER_SPLIT_DEFAULT = 0.5;
const EXPLORER_SPLIT_MIN = 0.22;
const EXPLORER_SPLIT_MAX = 0.78;
const SESSION_CACHE_TTL_MS = 2 * 60 * 1000;
const CHAT_SESSION_SCOPE = "chat";

type SessionCacheEntry = {
  sessions: SessionInfo[];
  cachedAt: number;
};

const sessionCache = new Map<string, SessionCacheEntry>();

function clampExplorerRatio(value: number) {
  return Math.min(EXPLORER_SPLIT_MAX, Math.max(EXPLORER_SPLIT_MIN, value));
}

function sessionCacheKey(cwd: string | null): string {
  return `${CHAT_SESSION_SCOPE}:${cwd ?? "all"}`;
}

function getCachedSessions(cwd: string | null): SessionInfo[] | null {
  const cached = sessionCache.get(sessionCacheKey(cwd));
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(sessionCacheKey(cwd));
    return null;
  }
  return cached.sessions;
}

function setCachedSessions(cwd: string | null, sessions: SessionInfo[]): void {
  sessionCache.set(sessionCacheKey(cwd), { sessions, cachedAt: Date.now() });
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** Return the 5 most recently active cwds across all sessions */
function getRecentCwds(sessions: SessionInfo[]): string[] {
  const latestByCwd = new Map<string, string>(); // cwd -> most recent modified
  for (const s of sessions) {
    if (!s.cwd) continue;
    const prev = latestByCwd.get(s.cwd);
    if (!prev || s.modified > prev) {
      latestByCwd.set(s.cwd, s.modified);
    }
  }
  return [...latestByCwd.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 5)
    .map(([cwd]) => cwd);
}

function shortenCwd(cwd: string, homeDir?: string): string {
  const path = (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join(sep);
}

function isNorthstarRuntimeSession(session: SessionInfo): boolean {
  const firstMessage = session.firstMessage.trim();
  return session.cwd.includes("/.northstar/runtime/") ||
    firstMessage.startsWith("You are executing a Northstar software-development") ||
    firstMessage.startsWith("請啟動 northstar skill watch");
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

export function PiAgentTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Southstar";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      aria-label={showVersion ? "Southstar version" : "Southstar"}
      title={showVersion ? "App version" : "Show app version"}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        display: "flex", alignItems: "center", justifyContent: "flex-start",
        height: 32,
        fontWeight: 700, fontSize: 15, letterSpacing: 0,
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: showVersion ? "6ch" : 126,
      }}
    >
      {showVersion ? display : <SouthstarLogoMark />}
    </button>
  );
}

export function SouthstarLogoMark() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span
        aria-hidden="true"
        style={{
          width: 24,
          height: 24,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--accent)",
          flexShrink: 0,
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2.8l1.9 6.8 6.8 1.9-6.8 1.9L12 20.2l-1.9-6.8-6.8-1.9 6.8-1.9L12 2.8z" />
          <circle cx="12" cy="12" r="3.1" />
          <path d="M12 20.2v1.5" />
        </svg>
      </span>
      <span style={{ color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        Southstar
      </span>
    </span>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention }: Props) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadById, setUnreadById] = useState<Record<string, number>>({});
  const [selectedCwd, setSelectedCwd] = useState<string | null>(selectedCwdProp ?? null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerRatio, setExplorerRatio] = useState(EXPLORER_SPLIT_DEFAULT);
  const [splitResizing, setSplitResizing] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMessageCountRef = useRef<Map<string, number>>(new Map());
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const lastNotifiedCwdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(EXPLORER_SPLIT_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      setExplorerRatio(clampExplorerRatio(stored));
    }
  }, []);

  const clearSplitResizeStyles = useCallback(() => {
    if (splitResizing) return;
    if (document.body.style.cursor === "ns-resize") {
      document.body.style.cursor = "";
    }
    if (document.body.style.userSelect === "none") {
      document.body.style.userSelect = "";
    }
  }, [splitResizing]);

  useEffect(() => {
    clearSplitResizeStyles();
  });

  useEffect(() => {
    return () => {
      clearSplitResizeStyles();
    };
  }, [clearSplitResizeStyles]);

  const handleExplorerSplitPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = splitContainerRef.current;
    if (!container) return;

    event.preventDefault();
    const height = Math.max(1, container.getBoundingClientRect().height);
    const startY = event.clientY;
    const startRatio = explorerRatio;

    setSplitResizing(true);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    const updateRatio = (clientY: number) => {
      const next = clampExplorerRatio(startRatio - ((clientY - startY) / height));
      setExplorerRatio(next);
      return next;
    };

  const cleanup = () => {
      setSplitResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateRatio(moveEvent.clientY);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      const next = updateRatio(upEvent.clientY);
      window.localStorage.setItem(EXPLORER_SPLIT_STORAGE_KEY, String(next));
      cleanup();
    };

    const onPointerCancel = () => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  }, [explorerRatio]);
  const loadSessions = useCallback(async (showLoading = false, markRefreshed = true, cwdOverride?: string | null, forceRefresh = false) => {
    try {
      const cwdForRequest = cwdOverride ?? selectedCwd;
      if (!forceRefresh) {
        const cached = getCachedSessions(cwdForRequest);
        if (cached) {
          setAllSessions(cached);
          setError(null);
          return;
        }
      }

      if (showLoading) setLoading(true);
      const sessionsUrl = cwdForRequest
        ? `/api/sessions?kind=chat&cwd=${encodeURIComponent(cwdForRequest)}`
        : "/api/sessions?kind=chat&scope=all";
      const res = await fetch(sessionsUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[] };
      const nextSessions = data.sessions;
      const nextCounts = new Map<string, number>();
      for (const s of nextSessions) nextCounts.set(s.id, s.messageCount);

      setUnreadById((prev) => {
        const next = { ...prev };
        for (const s of nextSessions) {
          const prevCount = prevMessageCountRef.current.get(s.id);
          if (prevCount !== undefined && s.messageCount > prevCount && s.id !== selectedSessionId) {
            next[s.id] = (next[s.id] ?? 0) + (s.messageCount - prevCount);
          }
        }
        for (const id of Object.keys(next)) {
          if (!nextCounts.has(id) || id === selectedSessionId) delete next[id];
        }
        return next;
      });
      prevMessageCountRef.current = nextCounts;
      setAllSessions(nextSessions);
      setCachedSessions(cwdForRequest, nextSessions);
      setError(null);
      if (!showLoading && markRefreshed) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [selectedCwd, selectedSessionId]);

  useEffect(() => {
    loadSessions(false);
  }, [loadSessions, refreshKey, selectedCwd]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      loadSessions(false, false);
    }, 15000);
    return () => clearInterval(t);
  }, [loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadById((prev) => {
      if (!(selectedSessionId in prev)) return prev;
      const next = { ...prev };
      delete next[selectedSessionId];
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  useEffect(() => {
    setSelectedCwd((prev) => {
      if (!selectedCwdProp || prev === selectedCwdProp) return prev;
      return selectedCwdProp;
    });
  }, [selectedCwdProp]);

  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd);
  }, [selectedCwd, onCwdChange]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0) return;

    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        setSelectedCwd(target.cwd);
        onSelectSession(target, true);
        return;
      }
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }

    if (selectedCwd === null) {
      const cwds = getRecentCwds(allSessions.filter((session) => !isNorthstarRuntimeSession(session)));
      if (cwds.length > 0) setSelectedCwd(cwds[0]);
    }
  }, [allSessions, selectedCwd, initialSessionId, onSelectSession, onInitialRestoreDone]);

  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;
    setCustomPathError(null);
    setCustomPathValidating(true);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json() as { cwd?: string; error?: string };
      if (!res.ok || !data.cwd) {
        setCustomPathError(data.error ?? "Directory does not exist");
        return;
      }
      setSelectedCwd(data.cwd);
      await loadSessions(false, false, data.cwd, true);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch {
      setCustomPathError("Could not validate directory");
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, loadSessions]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        await loadSessions(false, false, data.cwd, true);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [loadSessions]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setCustomPathOpen(false);
        setCustomPathValue("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  const visibleSessions = allSessions.filter((session) => !isNorthstarRuntimeSession(session));
  const recentCwds = (() => {
    const cwds = getRecentCwds(visibleSessions);
    return selectedCwd && !cwds.includes(selectedCwd) ? [selectedCwd, ...cwds] : cwds;
  })();
  const filteredSessions = selectedCwd
    ? visibleSessions.filter((s) => s.cwd === selectedCwd)
    : visibleSessions;

  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(filteredSessions);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiAgentTitle />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleNewSession}
              disabled={!selectedCwd}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: selectedCwd ? "pointer" : "not-allowed",
                height: 32,
                paddingLeft: 10,
                paddingRight: 12,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              title={selectedCwd ? `New session in ${selectedCwd}` : "Select a project first"}
              onMouseEnter={(e) => {
                if (!selectedCwd) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              New
            </button>
            <button
              onClick={() => loadSessions(false, true, undefined, true)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
              title="Refresh"
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: selectedCwd ? "var(--text)" : "var(--text-dim)",
              }}
              title={selectedCwd ?? ""}
            >
              {selectedCwd ? shortenCwd(selectedCwd, homeDir) : (initialSessionId && !restoredRef.current ? "" : "Select project…")}
            </span>
          </button>

          {dropdownOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                zIndex: 100,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                overflow: "hidden",
              }}
            >
              {recentCwds.map((cwd) => (
                <button
                  key={cwd}
                  onClick={() => {
                    setSelectedCwd(cwd);
                    setCustomPathOpen(false);
                    setCustomPathValue("");
                    setDropdownOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: cwd === selectedCwd ? "var(--bg-selected)" : "none",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    color: cwd === selectedCwd ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={cwd}
                >
                  {cwd === selectedCwd && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <polyline points="1.5 5 4 7.5 8.5 2.5" />
                    </svg>
                  )}
                  {cwd !== selectedCwd && <span style={{ width: 10, flexShrink: 0 }} />}
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortenCwd(cwd, homeDir)}</span>
                </button>
              ))}

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: recentCwds.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                  <span>Use default directory</span>
                </button>
              )}

              {/* Custom path entry */}
              {!customPathOpen ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCustomPathOpen(true);
                    setTimeout(() => customPathInputRef.current?.focus(), 0);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="5" y1="1" x2="5" y2="9" />
                    <line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  <span>Custom path…</span>
                </button>
              ) : (
                <div style={{ padding: "6px 8px", borderTop: recentCwds.length > 0 ? "none" : undefined }}>
                  <input
                    ref={customPathInputRef}
                    value={customPathValue}
                    onChange={(e) => {
                      setCustomPathValue(e.target.value);
                      if (customPathError) setCustomPathError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitCustomPath();
                      }
                      if (e.key === "Escape") {
                        setCustomPathOpen(false);
                        setCustomPathValue("");
                        setCustomPathError(null);
                      }
                    }}
                    placeholder="/path/to/project"
                    disabled={customPathValidating}
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--accent)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                  {customPathError && (
                    <div style={{ marginTop: 5, color: "#ef4444", fontSize: 11, lineHeight: 1.35 }}>
                      {customPathError}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                    <button
                      onClick={() => { void commitCustomPath(); }}
                      disabled={customPathValidating}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--accent)",
                        border: "none",
                        borderRadius: 5,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: customPathValidating ? "wait" : "pointer",
                        opacity: customPathValidating ? 0.7 : 1,
                      }}
                    >
                      {customPathValidating ? "Checking..." : "Open"}
                    </button>
                    <button
                      onClick={() => { setCustomPathOpen(false); setCustomPathValue(""); setCustomPathError(null); }}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        color: "var(--text-muted)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div ref={splitContainerRef} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        {/* Session list */}
          <div
            onPointerEnter={clearSplitResizeStyles}
            style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? `${1 - explorerRatio} 1 0` : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}
          >
          {loading && (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              Loading...
            </div>
          )}
          {error && (
            <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && filteredSessions.length === 0 && (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              No sessions found
            </div>
          )}
          {sessionTree.map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              unreadById={unreadById}
              onSelectSession={onSelectSession}
              onRenamed={() => loadSessions(false, true, undefined, true)}
              onSessionDeleted={(id) => {
                onSessionDeleted?.(id);
                loadSessions(false, true, undefined, true);
              }}
              depth={0}
            />
          ))}
        </div>

        {explorerOpen && (selectedCwdProp || selectedCwd) && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize Explorer"
            title="Resize Explorer"
            onPointerDown={handleExplorerSplitPointerDown}
            style={{
              flex: "0 0 7px",
              cursor: "ns-resize",
              background: splitResizing ? "var(--bg-hover)" : "var(--bg-panel)",
              borderTop: "1px solid var(--border)",
              borderBottom: "1px solid var(--border)",
              position: "relative",
              touchAction: "none",
              userSelect: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 28,
                height: 2,
                borderRadius: 999,
                background: splitResizing ? "var(--accent)" : "var(--border)",
                transform: "translate(-50%, -50%)",
              }}
            />
          </div>
        )}

        {/* File Explorer section */}
        {(selectedCwdProp || selectedCwd) && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: explorerOpen ? `${explorerRatio} 1 0` : "0 0 auto",
              minHeight: 0,
              overflow: "hidden",
              cursor: "default",
            }}
            onPointerEnter={clearSplitResizeStyles}
          >
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              <button
                onClick={() => setExplorerOpen((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flex: 1,
                  padding: "6px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  textAlign: "left",
                }}
              >
                <svg
                  width="9" height="9" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
                >
                  <polyline points="3 2 7 5 3 8" />
                </svg>
                Explorer
              </button>
              <button
                onClick={() => {
                  setExplorerKey((k) => k + 1);
                  setExplorerRefreshDone(true);
                  if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                  explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
                }}
                title="Refresh explorer"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, padding: 0, marginRight: 6,
                  background: explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none",
                  border: "none",
                  color: explorerRefreshDone ? "#4ade80" : "var(--text-dim)",
                  cursor: "pointer",
                  borderRadius: 5,
                  flexShrink: 0,
                  transition: "color 0.3s, background 0.3s",
                }}
                onMouseEnter={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                {explorerRefreshDone ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                )}
              </button>
            </div>
            {explorerOpen && (
              <div onPointerEnter={clearSplitResizeStyles} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", cursor: "default" }}>
                <FileExplorer
                  cwd={selectedCwdProp ?? selectedCwd!}
                  onOpenFile={onOpenFile ?? (() => {})}
                  refreshKey={explorerKey}
                  onAtMention={onAtMention}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  unreadById,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  unreadById: Record<string, number>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          unreadCount={unreadById[node.session.id] ?? 0}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              unreadById={unreadById}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  unreadCount,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  unreadCount: number;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const runtimeLabel = session.agentState?.isCompacting
    ? "compacting"
    : session.agentState?.isStreaming
      ? "streaming"
      : session.agentState?.running
        ? "running"
        : null;

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Delete <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              Delete
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text)",
              }}
              title={title}
            >
              {title}
            </div>
            <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 11, alignItems: "center" }}>
              <span title={session.modified}>{formatRelativeTime(session.modified)}</span>
              <span>{session.messageCount} msgs</span>
              {runtimeLabel && (
                <span style={{
                  fontSize: 10,
                  color: session.agentState?.isCompacting ? "#f59e0b" : "#10b981",
                  border: `1px solid ${session.agentState?.isCompacting ? "rgba(245,158,11,0.35)" : "rgba(16,185,129,0.35)"}`,
                  borderRadius: 999,
                  padding: "0 6px",
                  lineHeight: "16px",
                }}>
                  {runtimeLabel}
                </span>
              )}
              {unreadCount > 0 && !isSelected && (
                <span style={{
                  fontSize: 10,
                  color: "#2563eb",
                  border: "1px solid rgba(37,99,235,0.35)",
                  borderRadius: 999,
                  padding: "0 6px",
                  lineHeight: "16px",
                }}>
                  +{unreadCount}
                </span>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "Expand forks" : "Collapse forks"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover */}
          {hovered && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title="Rename"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title="Delete"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
