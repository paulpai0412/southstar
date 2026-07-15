"use client";

import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { LibraryWorkspaceModel, LibraryWorkspaceObject, LibraryWorkspaceObjectGroup } from "@/lib/library/types";
import type { SessionInfo } from "@/lib/types";
import { FolderIcon } from "../FileIcons";
import { ProjectScopePicker } from "../ProjectScopePicker";

const domainTreeFolders = [
  { label: "agents", objectKinds: ["agent_definition", "agent_spec"] },
  { label: "skills", objectKinds: ["skill_spec", "skill_definition"] },
  { label: "mcp", objectKinds: ["mcp_tool_grant"] },
  { label: "tools", objectKinds: ["tool_definition"] },
] as const;

type LibraryTreeObjectNode = {
  type: "object";
  id: string;
  object: LibraryWorkspaceObject;
};

type LibraryTreeFolderNode = {
  type: "folder";
  id: string;
  label: string;
  count: number;
  objects: LibraryTreeObjectNode[];
};

type LibraryTreeDomainNode = {
  type: "domain";
  id: string;
  label: string;
  count: number;
  folders: LibraryTreeFolderNode[];
};

export function LibrarySidebar({
  model,
  sessions = [],
  selectedSessionId,
  selectedScope,
  selectedObjectKey,
  selectedCwd,
  statusFilter,
  onCwdChange,
  onSelectScope,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onNewSession,
  onRefresh,
  onSelectObject,
}: {
  model: LibraryWorkspaceModel | null;
  sessions?: SessionInfo[];
  selectedSessionId?: string;
  selectedScope: string;
  selectedObjectKey?: string;
  selectedCwd: string | null;
  statusFilter: string;
  onCwdChange?: (cwd: string | null) => void;
  onSelectScope: (scope: string) => void;
  onStatusFilterChange: (status: string) => void;
  onSelectSession?: (session: SessionInfo) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  onRefresh?: () => void;
  onSelectObject: (object: LibraryWorkspaceObject) => void;
}) {
  const domains = model?.domains ?? [];
  const [treeOpen, setTreeOpen] = useState(true);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [treeRefreshDone, setTreeRefreshDone] = useState(false);
  const treeNodes = buildLibraryTreeNodes(domains, {
    domainFilter: "",
    statusFilter,
  });
  const isOpen = (key: string) => openMap[key] ?? true;
  const toggle = (key: string) => setOpenMap((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  const markSessionRefreshDone = () => {
    setSessionRefreshDone(true);
    window.setTimeout(() => setSessionRefreshDone(false), 1800);
  };
  const markTreeRefreshDone = () => {
    setTreeRefreshDone(true);
    window.setTimeout(() => setTreeRefreshDone(false), 1800);
  };
  const handleSessionRefresh = () => {
    onRefresh?.();
    markSessionRefreshDone();
  };
  const handleTreeRefresh = () => {
    onRefresh?.();
    markTreeRefreshDone();
  };
  const handleRefresh = () => {
    handleSessionRefresh();
  };

  return (
    <div data-testid="library-sidebar-content" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ProjectScopePicker
        selectedCwd={selectedCwd}
        onCwdChange={onCwdChange ?? (() => {})}
        emptyLabel="Select project..."
        actions={(
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={onNewSession}
              disabled={!onNewSession || !selectedCwd}
              title="New Library session"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: onNewSession && selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: onNewSession && selectedCwd ? "pointer" : "not-allowed",
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
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              New
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              title="Refresh"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32,
                height: 32,
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
        )}
      />

      <section style={{ flex: "0 0 28%", minHeight: 112, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <div style={sessionListTitleStyle}>Library LLM Sessions</div>
        <div data-testid="library-session-list" style={{ padding: "0 6px 8px" }}>
          {sessions.length === 0 ? (
            <div style={{ padding: "8px 8px 6px", color: "var(--text-dim)", fontSize: 12 }}>
              No Library LLM sessions
            </div>
          ) : sessions.map((session) => (
            <LibrarySessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              onSelect={onSelectSession}
              onRename={onRenameSession}
              onDelete={onDeleteSession}
            />
          ))}
        </div>
      </section>

      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <SectionHeader
          title="Library Domain Tree"
          open={treeOpen}
          onToggle={() => setTreeOpen((value) => !value)}
          action={<SectionRefreshButton done={treeRefreshDone} label="Refresh Library Domain Tree" onClick={handleTreeRefresh} />}
        />
        {treeOpen && (
          <div
            data-testid="library-domain-tree"
            role="tree"
            aria-label="Library Domain Tree"
            style={{ padding: "0 6px 8px" }}
          >
            {treeNodes.map((domain) => {
              const domainKey = domain.id;
              return (
                <div
                  key={domain.id}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={isOpen(domainKey)}
                  aria-selected={selectedScope === domain.label}
                  aria-label={`${domain.label} ${domain.count}`}
                  style={{ position: "relative" }}
                >
                  <DomainRow
                    label={domain.label}
                    count={domain.count}
                    selected={selectedScope === domain.label}
                    open={isOpen(domainKey)}
                    onToggle={() => toggle(domainKey)}
                    onSelect={() => onSelectScope(domain.label)}
                  />
                  {isOpen(domainKey) && (
                    <div role="group" style={{ position: "relative", marginLeft: 9 }}>
                      <span
                        data-testid="library-tree-connector"
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          left: 7,
                          top: 0,
                          bottom: 6,
                          width: 1,
                          background: "var(--border)",
                          opacity: 0.8,
                        }}
                      />
                      {domain.folders.map((folder) => {
                        const folderKey = folder.id;
                        return (
                          <div
                            key={folderKey}
                            role="treeitem"
                            aria-level={2}
                            aria-expanded={isOpen(folderKey)}
                            aria-label={`${folder.label} ${folder.count}`}
                            style={{ position: "relative" }}
                          >
                            <TreeFolderRow
                              label={folder.label}
                              count={folder.count}
                              depth={1}
                              open={isOpen(folderKey)}
                              onToggle={() => toggle(folderKey)}
                            />
                            {isOpen(folderKey) && (
                              <div role="group">
                                {folder.objects.map((node) => (
                                  <div
                                    key={node.id}
                                    role="treeitem"
                                    aria-level={3}
                                    aria-selected={selectedObjectKey === node.object.objectKey}
                                    aria-label={`${node.object.title} ${node.object.objectKey} ${node.object.status}`}
                                  >
                                    <LibraryObjectRow
                                      object={node.object}
                                      selected={selectedObjectKey === node.object.objectKey}
                                      onSelectObject={onSelectObject}
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
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

function SectionHeader({
  title,
  open,
  onToggle,
  action,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
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
        type="button"
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

const sessionListTitleStyle = {
  padding: "7px 10px",
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 650,
  textTransform: "uppercase",
} as const;

function LibrarySessionRow({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionInfo;
  selected: boolean;
  onSelect?: (session: SessionInfo) => void;
  onRename?: (sessionId: string, title: string) => void;
  onDelete?: (sessionId: string) => void;
}) {
  const title = session.name
    || (session as SessionInfo & { title?: string }).title
    || session.firstMessage
    || "Untitled Library session";
  const rename = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const next = window.prompt("Rename Library session", title)?.trim();
    if (next && next !== title) onRename?.(session.id, next);
  };
  const remove = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (window.confirm(`Delete "${title}"?`)) onDelete?.(session.id);
  };

  return (
    <div
      className="southstar-session-row"
      data-testid="library-session-row"
      aria-pressed={selected}
      onClick={() => onSelect?.(session)}
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
        cursor: onSelect ? "pointer" : "default",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <span className="southstar-session-row-actions">
          <SessionIconButton title="Rename" onClick={rename}>
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </SessionIconButton>
          <SessionIconButton title="Delete" onClick={remove}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </SessionIconButton>
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "var(--text-dim)", fontSize: 11 }}>
        <span>{session.kind}</span>
        <span>{formatRelativeTime(session.modified)}</span>
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

function DomainRow({
  label,
  count,
  selected,
  open,
  onToggle,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 4,
        borderRadius: 5,
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        fontSize: 12,
        fontWeight: 650,
        textAlign: "left",
      }}
    >
      <button
        type="button"
        aria-label={`Toggle ${label}`}
        aria-expanded={open}
        onClick={onToggle}
        style={{
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
        }}
      >
        <Chevron open={open} />
      </button>
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={onSelect}
        style={{
          minWidth: 0,
          flex: "1 1 auto",
          height: 26,
          display: "flex",
          alignItems: "center",
          border: "none",
          background: "transparent",
          color: "var(--text)",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
          fontWeight: 650,
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </button>
      <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{count}</span>
    </div>
  );
}

function TreeFolderRow({
  label,
  count,
  depth,
  open,
  onToggle,
}: {
  label: string;
  count: number;
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
      <span
        data-testid="library-tree-branch"
        aria-hidden="true"
        style={{
          width: 12,
          height: 1,
          marginLeft: -8,
          background: "var(--border)",
          opacity: 0.8,
          flexShrink: 0,
        }}
      />
      <Chevron open={open} />
      <FolderIcon size={14} open={open} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{count}</span>
    </button>
  );
}

function LibraryObjectRow({
  object,
  selected,
  onSelectObject,
}: {
  object: LibraryWorkspaceObject;
  selected: boolean;
  onSelectObject: (object: LibraryWorkspaceObject) => void;
}) {
  return (
    <button
      type="button"
      data-testid="library-object-row"
      aria-pressed={selected}
      onClick={() => onSelectObject(object)}
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 6,
        alignItems: "center",
        textAlign: "left",
        border: `1px solid ${selected ? "var(--accent)" : "transparent"}`,
        borderRadius: 6,
        background: selected ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
        color: "var(--text)",
        padding: "6px 8px",
        marginTop: 2,
        marginLeft: 36,
        cursor: "pointer",
        position: "relative",
      }}
    >
      <span
        data-testid="library-tree-branch"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: -21,
          top: "50%",
          width: 18,
          height: 1,
          background: "var(--border)",
          opacity: 0.8,
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {object.title}
        </span>
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {object.objectKey}
        </span>
      </span>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{object.status}</span>
    </button>
  );
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
        flexShrink: 0,
      }}
    >
      <polyline points="3 2 7 5 3 8" />
    </svg>
  );
}

function objectsForDomainAndKinds(
  domain: LibraryWorkspaceModel["domains"][number],
  objectKinds: readonly string[],
): LibraryWorkspaceObject[] {
  const allowedKinds = new Set(objectKinds);
  return objectGroupsForDomain(domain)
    .filter((group) => allowedKinds.has(group.objectKind))
    .flatMap((group) => group.objects);
}

function objectGroupsForDomain(domain: LibraryWorkspaceModel["domains"][number]): LibraryWorkspaceObjectGroup[] {
  if (domain.objectGroups) return domain.objectGroups;
  const groups = new Map<string, LibraryWorkspaceObject[]>();
  for (const object of domain.objects ?? []) {
    const objects = groups.get(object.objectKind) ?? [];
    objects.push(object);
    groups.set(object.objectKind, objects);
  }
  return Array.from(groups.entries()).map(([objectKind, objects]) => ({ objectKind, objects }));
}

function buildLibraryTreeNodes(
  domains: LibraryWorkspaceModel["domains"],
  input: { domainFilter: string; statusFilter: string },
): LibraryTreeDomainNode[] {
  return domains
    .filter((domain) => !input.domainFilter || domain.scope.toLowerCase().includes(input.domainFilter))
    .map((domain) => {
      const folders = domainTreeFolders.map((folder) => {
        const objects = objectsForDomainAndKinds(domain, folder.objectKinds)
          .filter((object) => input.statusFilter === "all" || object.status === input.statusFilter)
          .map((object): LibraryTreeObjectNode => ({
            type: "object",
            id: `object:${object.objectKey}`,
            object,
          }));
        return {
          type: "folder" as const,
          id: `domain:${domain.scope}:folder:${folder.label}`,
          label: folder.label,
          count: objects.length,
          objects,
        };
      }).filter((folder) => folder.count > 0);
      return {
        type: "domain" as const,
        id: `domain:${domain.scope}`,
        label: domain.scope,
        count: folders.reduce((sum, folder) => sum + folder.count, 0),
        folders,
      };
    })
    .filter((domain) => domain.count > 0);
}

function formatRelativeTime(value?: string): string {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const deltaMs = Date.now() - time;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
