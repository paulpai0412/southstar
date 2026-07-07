"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { groupSkillResourcePaths } from "@/lib/workflow/skill-resource-tree";
import type { WorkflowAgentSummary, WorkflowLibrary, WorkflowTemplateSummary } from "@/lib/workflow/types";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { PiAgentTitle } from "./SessionSidebar";

interface Props {
  cwd: string | null;
  selectedSessionId: string | null;
  selectedTemplateId: string | null;
  onSessionSelect: (session: SessionInfo) => void;
  onTemplateSelect: (template: WorkflowTemplateSummary) => void;
  onTemplateMention?: (template: WorkflowTemplateSummary) => void;
  onOpenResource: (resourcePath: string, label: string) => void;
  onCwdChange?: (cwd: string | null) => void;
  onNewSession?: () => void;
  onRefreshSessions?: () => void;
  onSessionDeleted?: (sessionId: string) => void;
}

export function WorkflowSidebar({
  cwd,
  selectedSessionId,
  selectedTemplateId,
  onSessionSelect,
  onTemplateSelect,
  onTemplateMention,
  onOpenResource,
  onCwdChange,
  onNewSession,
  onRefreshSessions,
  onSessionDeleted,
}: Props) {
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const [library, setLibrary] = useState<WorkflowLibrary | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [libraryRefreshDone, setLibraryRefreshDone] = useState(false);

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
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const url = cwd ? `/api/workflow/library?cwd=${encodeURIComponent(cwd)}` : "/api/workflow/library";
    fetch(url)
      .then((res) => res.json())
      .then((data: { library?: WorkflowLibrary; error?: string }) => {
        if (data.error) throw new Error(data.error);
        setLibrary(data.library ?? { domains: [] });
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [cwd, libraryRefreshKey]);

  useEffect(() => {
    const url = cwd
      ? `/api/sessions?kind=workflow&cwd=${encodeURIComponent(cwd)}`
      : "/api/sessions?scope=all&kind=workflow&limit=50&compact=1";
    fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { sessions?: SessionInfo[]; error?: string }) => {
        if (data.error) throw new Error(data.error);
        setSessions(data.sessions ?? []);
        setSessionError(null);
      })
      .catch((err) => setSessionError(err instanceof Error ? err.message : String(err)));
  }, [cwd, sessionRefreshKey]);

  const templates = useMemo(
    () => library?.domains.flatMap((domain) => domain.workflowTemplates) ?? [],
    [library]
  );
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null;
  const domains = library?.domains ?? [];

  useEffect(() => {
    if (!selectedTemplateId && selectedTemplate) onTemplateSelect(selectedTemplate);
  }, [selectedTemplateId, selectedTemplate, onTemplateSelect]);

  const toggle = useCallback((key: string) => {
    setOpenMap((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }, []);

  const isOpen = useCallback((key: string) => openMap[key] ?? true, [openMap]);

  const markSessionRefreshDone = useCallback(() => {
    setSessionRefreshDone(true);
    window.setTimeout(() => setSessionRefreshDone(false), 1800);
  }, []);

  const markLibraryRefreshDone = useCallback(() => {
    setLibraryRefreshDone(true);
    window.setTimeout(() => setLibraryRefreshDone(false), 1800);
  }, []);

  const handleSessionRefresh = useCallback(() => {
    setSessionRefreshKey((value) => value + 1);
    onRefreshSessions?.();
    markSessionRefreshDone();
  }, [markSessionRefreshDone, onRefreshSessions]);

  const handleLibraryRefresh = useCallback(() => {
    setLibraryRefreshKey((value) => value + 1);
    markLibraryRefreshDone();
  }, [markLibraryRefreshDone]);

  const handleRefresh = useCallback(() => {
    handleSessionRefresh();
  }, [handleSessionRefresh]);

  const renameSession = useCallback(async (session: SessionInfo) => {
    const title = session.name || session.firstMessage || "Untitled workflow";
    const name = window.prompt("Rename workflow session", session.name ?? title)?.trim();
    if (name === undefined || name === (session.name ?? "")) return;
    await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, name } : item));
    onRefreshSessions?.();
  }, [onRefreshSessions]);

  const deleteSession = useCallback(async (session: SessionInfo) => {
    const title = session.name || session.firstMessage || "Untitled workflow";
    if (!window.confirm(`Delete "${title}"?`)) return;
    await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    setSessions((current) => current.filter((item) => item.id !== session.id));
    onSessionDeleted?.(session.id);
    onRefreshSessions?.();
  }, [onRefreshSessions, onSessionDeleted]);

  const commitCustomPath = useCallback(async () => {
    const nextCwd = customPathValue.trim();
    if (!nextCwd || !onCwdChange) return;
    setCustomPathError(null);
    setCustomPathValidating(true);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: nextCwd }),
      });
      const data = await res.json() as { cwd?: string; error?: string };
      if (!res.ok || !data.cwd) {
        setCustomPathError(data.error || "Directory does not exist");
        return;
      }
      onCwdChange(data.cwd);
      setCustomPathValue("");
      setCustomPathOpen(false);
      setProjectMenuOpen(false);
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, onCwdChange]);

  return (
    <div data-testid="workflow-sidebar" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
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
              onClick={onNewSession}
              disabled={!cwd || !onNewSession}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: cwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: cwd ? "pointer" : "not-allowed",
                height: 32,
                paddingLeft: 10,
                paddingRight: 12,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: 0,
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              title={cwd ? `New session in ${cwd}` : "Select a project first"}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              New
            </button>
            <button
              onClick={handleRefresh}
              title="Refresh"
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
        <div ref={projectMenuRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => {
              if (!onCwdChange) return;
              setProjectMenuOpen((value) => !value);
            }}
            style={{
              width: "100%",
              padding: "6px 10px",
              background: cwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: cwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              fontSize: 11,
              color: cwd ? "var(--text)" : "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: onCwdChange ? "pointer" : "default",
            }}
            title={cwd ?? ""}
          >
            {cwd ? shortenCwd(cwd, homeDir) : "Select project..."}
          </button>
          {projectMenuOpen && (
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
              {cwd && (
                <button
                  type="button"
                  onClick={() => {
                    onCwdChange?.(null);
                    setProjectMenuOpen(false);
                  }}
                  style={projectMenuItemStyle}
                >
                  Select project...
                </button>
              )}
              {customPathOpen ? (
                <div style={{ padding: "6px 8px" }}>
                  <input
                    data-testid="workflow-project-custom-path"
                    value={customPathValue}
                    onChange={(event) => setCustomPathValue(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void commitCustomPath();
                      }
                      if (event.key === "Escape") {
                        setCustomPathOpen(false);
                        setCustomPathValue("");
                        setCustomPathError(null);
                      }
                    }}
                    placeholder="/path/to/project"
                    disabled={customPathValidating}
                    autoFocus
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
                      type="button"
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
                      {customPathValidating ? "Checking..." : "Use"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomPathOpen(false);
                        setCustomPathValue("");
                        setCustomPathError(null);
                      }}
                      style={{
                        padding: "4px 8px",
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
              ) : (
                <button
                  type="button"
                  onClick={() => setCustomPathOpen(true)}
                  style={projectMenuItemStyle}
                >
                  Custom path...
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div style={{ padding: 10, color: "#f87171", fontSize: 12 }}>{error}</div>}
      {sessionError && <div style={{ padding: 10, color: "#f87171", fontSize: 12 }}>{sessionError}</div>}

      <section style={{ flex: "0 0 28%", minHeight: 112, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <div style={sessionListTitleStyle}>Workflow Sessions</div>
        <div data-testid="workflow-session-list" style={{ padding: "0 6px 8px" }}>
          {sessions.length === 0 ? (
            <div style={{ padding: "8px 8px 6px", color: "var(--text-dim)", fontSize: 12 }}>
              No workflow sessions
            </div>
          ) : sessions.map((session) => (
            <WorkflowSessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              onSelect={onSessionSelect}
              onRename={renameSession}
              onDelete={deleteSession}
            />
          ))}
        </div>
      </section>

      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <SectionHeader
          title="Workflow Library"
          open={templatesOpen}
          onToggle={() => setTemplatesOpen((value) => !value)}
          action={<SectionRefreshButton done={libraryRefreshDone} label="Refresh workflow library" onClick={handleLibraryRefresh} />}
          testId="workflow-template-section-toggle"
        />
        {templatesOpen && (
          <div data-testid="workflow-template-tree" style={{ padding: "0 6px 8px" }}>
            {domains.map((domain) => {
              const domainKey = `templates:${domain.id}`;
              const workflowsKey = `templates:${domain.id}:workflows`;
              return (
                <div key={domain.id}>
                  <TreeFolderRow label={domain.id} depth={0} open={isOpen(domainKey)} onToggle={() => toggle(domainKey)} />
                  {isOpen(domainKey) && (
                    <>
                      <TreeFolderRow label="workflows" depth={1} open={isOpen(workflowsKey)} onToggle={() => toggle(workflowsKey)} />
                      {isOpen(workflowsKey) && domain.workflowTemplates.map((template) => (
                        <WorkflowTemplateTree
                          key={template.id}
                          template={template}
                          agents={domain.agents}
                          selected={selectedTemplate?.id === template.id}
                          isOpen={isOpen}
                          onToggle={toggle}
                          onTemplateSelect={onTemplateSelect}
                          onTemplateMention={onTemplateMention}
                          onOpenResource={onOpenResource}
                        />
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const projectMenuItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  width: "100%",
  padding: "8px 10px",
  background: "none",
  border: "none",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 11,
} as const;

const sessionListTitleStyle = {
  padding: "7px 10px",
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 650,
  textTransform: "uppercase",
} as const;

function shortenCwd(cwd: string, homeDir?: string): string {
  const path = homeDir && cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join(sep)}`;
}

function SectionHeader({
  title,
  open,
  onToggle,
  action,
  testId,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 6px 0 0",
        background: "transparent",
      }}
    >
      <button
        data-testid={testId}
        onClick={onToggle}
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 10px",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 650,
          textTransform: "uppercase",
          textAlign: "left",
        }}
      >
        <Chevron open={open} />
        {title}
      </button>
      {action}
    </div>
  );
}

function SectionRefreshButton({ done, label, onClick }: { done: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        padding: 0,
        border: "none",
        borderRadius: 5,
        background: done ? "rgba(74,222,128,0.18)" : "none",
        color: done ? "#4ade80" : "var(--text-dim)",
        cursor: "pointer",
        flexShrink: 0,
        transition: "color 0.3s, background 0.3s",
      }}
    >
      {done ? (
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
  );
}

function TreeFolderRow({
  label,
  depth,
  open,
  onToggle,
}: {
  label: string;
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: "100%",
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + depth * 14,
        border: "none",
        background: "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
      }}
    >
      <Chevron open={open} />
      <FolderIcon size={14} open={open} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

function FileRow({
  resourcePath,
  label,
  depth,
  onOpenResource,
}: {
  resourcePath: string;
  label: string;
  depth: number;
  onOpenResource: (resourcePath: string, label: string) => void;
}) {
  return (
    <button
      onClick={() => onOpenResource(resourcePath, label)}
      style={{
        width: "100%",
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + depth * 14,
        paddingRight: 8,
        border: "none",
        borderRadius: 4,
        background: "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 12,
        textAlign: "left",
      }}
    >
      <span style={{ width: 14, display: "flex", alignItems: "center" }}>{getFileIcon(label, 14)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

function WorkflowSessionRow({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionInfo;
  selected: boolean;
  onSelect: (session: SessionInfo) => void;
  onRename: (session: SessionInfo) => void;
  onDelete: (session: SessionInfo) => void;
}) {
  const title = session.name || session.firstMessage || "Untitled workflow";
  return (
    <div
      data-testid={`workflow-session-${session.id}`}
      onClick={() => onSelect(session)}
      style={{
        width: "100%",
        minHeight: 42,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 3,
        padding: "7px 8px",
        border: "none",
        borderRadius: 6,
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <SessionIconButton title="Rename" onClick={(event) => { event.stopPropagation(); onRename(session); }}>
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </SessionIconButton>
        <SessionIconButton title="Delete" onClick={(event) => { event.stopPropagation(); onDelete(session); }}>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </SessionIconButton>
      </span>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "var(--text-dim)", fontSize: 11 }}>
        <span>{formatRelativeTime(session.modified)}</span>
        <span>{session.messageCount} messages</span>
      </span>
    </div>
  );
}

function SessionIconButton({ title, onClick, children }: { title: string; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-hover)",
        color: "var(--text-muted)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function WorkflowTemplateTree({
  template,
  agents,
  selected,
  isOpen,
  onToggle,
  onTemplateSelect,
  onTemplateMention,
  onOpenResource,
}: {
  template: WorkflowTemplateSummary;
  agents: WorkflowAgentSummary[];
  selected: boolean;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onTemplateSelect: (template: WorkflowTemplateSummary) => void;
  onTemplateMention?: (template: WorkflowTemplateSummary) => void;
  onOpenResource: (resourcePath: string, label: string) => void;
}) {
  const [mentionVisible, setMentionVisible] = useState(false);
  const templateKey = `template:${template.id}`;
  const nodesKey = `${templateKey}:nodes`;
  const agentsKey = `${templateKey}:agents`;
  const templateAgents = agents.filter((agent) => template.agentRefs.includes(agent.id));
  return (
    <div>
      <div
        onMouseEnter={() => setMentionVisible(true)}
        onMouseLeave={() => setMentionVisible(false)}
        onFocus={() => setMentionVisible(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMentionVisible(false);
        }}
        style={{
          width: "100%",
          minHeight: 38,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 7px 0 36px",
          borderRadius: 6,
          background: selected ? "var(--bg-selected)" : "transparent",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        <button
          type="button"
          onClick={() => {
            onTemplateSelect(template);
            onToggle(templateKey);
          }}
          style={{
            minWidth: 0,
            flex: 1,
            minHeight: 38,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 0",
            border: "none",
            background: "transparent",
            color: "inherit",
            textAlign: "left",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <Chevron open={isOpen(templateKey)} />
          <span style={{ width: 14, display: "flex", alignItems: "center", flexShrink: 0 }}>{getFileIcon("workflow.json", 14)}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{template.title}</span>
            <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{template.nodes.length || template.stageRefs.length} nodes</span>
          </span>
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11 }}>{template.status}</span>
        </button>
        {onTemplateMention ? (
          <button
            type="button"
            data-testid="workflow-template-mention-button"
            title="Mention workflow template in chat"
            aria-label={`Mention ${template.title}`}
            onClick={() => onTemplateMention(template)}
            tabIndex={mentionVisible ? 0 : -1}
            style={{
              width: "auto",
              height: 20,
              flexShrink: 0,
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg-panel)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              lineHeight: "18px",
              whiteSpace: "nowrap",
              padding: "0 8px",
              visibility: mentionVisible ? "visible" : "hidden",
            }}
          >
            @ memtion
          </button>
        ) : null}
      </div>
      {isOpen(templateKey) && (
        <>
          <TreeFolderRow label="nodes" depth={3} open={isOpen(nodesKey)} onToggle={() => onToggle(nodesKey)} />
          {isOpen(nodesKey) && template.nodes.map((node) => (
            <TemplateNodeRow key={`${template.id}:${node.id}`} node={node} depth={4} />
          ))}
          <TreeFolderRow label="agents" depth={3} open={isOpen(agentsKey)} onToggle={() => onToggle(agentsKey)} />
          {isOpen(agentsKey) && templateAgents.map((agent, index) => (
            <AgentTree
              key={`${template.id}:${agent.id}:${agent.profileResourcePath}:${index}`}
              agent={agent}
              depth={4}
              isOpen={isOpen}
              onToggle={onToggle}
              onOpenResource={onOpenResource}
            />
          ))}
        </>
      )}
    </div>
  );
}

function TemplateNodeRow({
  node,
  depth,
}: {
  node: WorkflowTemplateSummary["nodes"][number];
  depth: number;
}) {
  return (
    <div
      title={`${node.title} (${node.id})`}
      style={{
        minHeight: 24,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + depth * 14,
        paddingRight: 8,
        color: "var(--text)",
        fontSize: 12,
      }}
    >
      <span style={{ width: 14, flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>N</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.title}</span>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>{node.id}</span>
      </span>
    </div>
  );
}

function AgentTree({
  agent,
  depth = 2,
  isOpen,
  onToggle,
  onOpenResource,
}: {
  agent: WorkflowAgentSummary;
  depth?: number;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onOpenResource: (resourcePath: string, label: string) => void;
}) {
  const baseKey = `agent:${agent.id}`;
  const skillsKey = `${baseKey}:skills`;
  const mcpKey = `${baseKey}:mcp`;
  const policiesKey = `${baseKey}:policies`;
  const skillGroups = groupSkillResourcePaths(agent.skillResourcePaths);

  return (
    <div>
      <TreeFolderRow label={agent.label} depth={depth} open={isOpen(baseKey)} onToggle={() => onToggle(baseKey)} />
      {isOpen(baseKey) && (
        <>
          {agent.profileResourcePath && (
            <FileRow resourcePath={agent.profileResourcePath} label={agent.profileResourcePath.split("/").at(-1) ?? "profile"} depth={depth + 1} onOpenResource={onOpenResource} />
          )}
          {agent.instructionResourcePath && (
            <FileRow resourcePath={agent.instructionResourcePath} label={agent.instructionResourcePath.split("/").at(-1) ?? "instruction"} depth={depth + 1} onOpenResource={onOpenResource} />
          )}

          <TreeFolderRow label="skills" depth={depth + 1} open={isOpen(skillsKey)} onToggle={() => onToggle(skillsKey)} />
          {isOpen(skillsKey) && skillGroups.map((group) => {
            const skillKey = `${skillsKey}:${group.skillName}`;
            return (
              <div key={group.skillName}>
                <TreeFolderRow label={group.skillName} depth={depth + 2} open={isOpen(skillKey)} onToggle={() => onToggle(skillKey)} />
                {isOpen(skillKey) && group.files.map((file) => (
                  <FileRow
                    key={file.resourcePath}
                    resourcePath={file.resourcePath}
                    label={file.label}
                    depth={depth + 3}
                    onOpenResource={onOpenResource}
                  />
                ))}
              </div>
            );
          })}

          <TreeFolderRow label="mcp" depth={depth + 1} open={isOpen(mcpKey)} onToggle={() => onToggle(mcpKey)} />
          {isOpen(mcpKey) && agent.mcpResourcePaths.map((resourcePath) => (
            <FileRow key={resourcePath} resourcePath={resourcePath} label={resourcePath.split("/").at(-1) ?? resourcePath} depth={depth + 2} onOpenResource={onOpenResource} />
          ))}

          <TreeFolderRow label="policies" depth={depth + 1} open={isOpen(policiesKey)} onToggle={() => onToggle(policiesKey)} />
          {isOpen(policiesKey) && agent.policyResourcePaths.map((resourcePath) => (
            <FileRow key={resourcePath} resourcePath={resourcePath} label={resourcePath.split("/").at(-1) ?? resourcePath} depth={depth + 2} onOpenResource={onOpenResource} />
          ))}
        </>
      )}
    </div>
  );
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        color: "var(--text-dim)",
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 0.12s",
      }}
    >
      <polyline points="3 2 7 5 3 8" />
    </svg>
  );
}
