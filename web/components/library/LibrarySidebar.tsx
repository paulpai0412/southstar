"use client";

import { useState } from "react";
import type { LibrarySessionSummary, LibraryWorkspaceModel, LibraryWorkspaceObject, LibraryWorkspaceObjectGroup } from "@/lib/library/types";
import { FolderIcon } from "../FileIcons";
import { PiAgentTitle } from "../SessionSidebar";

const domainTreeFolders = [
  { label: "agents", objectKinds: ["agent_definition", "agent_spec"] },
  { label: "skills", objectKinds: ["skill_spec", "skill_definition"] },
  { label: "mcp", objectKinds: ["mcp_tool_grant"] },
  { label: "tools", objectKinds: ["tool_definition"] },
] as const;

export function LibrarySidebar({
  model,
  sessions = [],
  selectedSessionId,
  selectedScope,
  selectedObjectKey,
  statusFilter,
  onSelectScope,
  onSelectSession,
  onNewSession,
  onRefresh,
  onSelectObject,
}: {
  model: LibraryWorkspaceModel | null;
  sessions?: LibrarySessionSummary[];
  selectedSessionId?: string;
  selectedScope: string;
  selectedObjectKey?: string;
  statusFilter: string;
  onSelectScope: (scope: string) => void;
  onStatusFilterChange: (status: string) => void;
  onSelectSession?: (session: LibrarySessionSummary) => void;
  onNewSession?: () => void;
  onRefresh?: () => void;
  onSelectObject: (object: LibraryWorkspaceObject) => void;
}) {
  const domains = model?.domains ?? [];
  const [domainFilter, setDomainFilter] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(true);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [refreshDone, setRefreshDone] = useState(false);
  const normalizedDomainFilter = domainFilter.trim().toLowerCase();
  const filteredDomains = normalizedDomainFilter
    ? domains.filter((domain) => domain.scope.toLowerCase().includes(normalizedDomainFilter))
    : domains;
  const isOpen = (key: string) => openMap[key] ?? true;
  const toggle = (key: string) => setOpenMap((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  const handleRefresh = () => {
    onRefresh?.();
    setRefreshDone(true);
    window.setTimeout(() => setRefreshDone(false), 1800);
  };

  return (
    <div data-testid="library-sidebar-content" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
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
              type="button"
              onClick={onNewSession}
              disabled={!onNewSession}
              title="New Library session"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: onNewSession ? "var(--text-muted)" : "var(--text-dim)",
                cursor: onNewSession ? "pointer" : "not-allowed",
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
                background: refreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${refreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: refreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32,
                height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
            >
              {refreshDone ? (
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
        <input
          data-testid="library-domain-filter"
          value={domainFilter}
          onChange={(event) => setDomainFilter(event.currentTarget.value)}
          placeholder="Filter Library Domain Tree..."
          style={{
            width: "100%",
            height: 28,
            fontSize: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text)",
            padding: "0 8px",
          }}
        />
      </div>

      <section style={{ flex: "0 0 28%", minHeight: 112, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <SectionHeader title="Library LLM Sessions" open={sessionsOpen} onToggle={() => setSessionsOpen((value) => !value)} />
        {sessionsOpen && (
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
              />
            ))}
          </div>
        )}
      </section>

      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <SectionHeader title="Library Domain Tree" open={treeOpen} onToggle={() => setTreeOpen((value) => !value)} />
        {treeOpen && (
          <div data-testid="library-domain-tree" style={{ padding: "0 6px 8px" }}>
            {filteredDomains.map((domain) => {
              const domainKey = `domain:${domain.scope}`;
              const folders = domainTreeFolders.map((folder) => ({
                ...folder,
                objects: objectsForDomainAndKinds(domain, folder.objectKinds)
                  .filter((object) => statusFilter === "all" || object.status === statusFilter),
              })).filter((folder) => folder.objects.length > 0);
              if (folders.length === 0) return null;
              return (
                <div key={domain.scope}>
                  <DomainRow
                    label={domain.scope}
                    selected={selectedScope === domain.scope}
                    open={isOpen(domainKey)}
                    onSelect={() => onSelectScope(domain.scope)}
                  />
                  {isOpen(domainKey) && folders.map((folder) => {
                    const folderKey = `${domainKey}:${folder.label}`;
                    return (
                      <div key={folderKey}>
                        <TreeFolderRow
                          label={folder.label}
                          depth={1}
                          open={isOpen(folderKey)}
                          onToggle={() => toggle(folderKey)}
                        />
                        {isOpen(folderKey) && folder.objects.map((object) => (
                          <LibraryObjectRow
                            key={object.objectKey}
                            object={object}
                            selected={selectedObjectKey === object.objectKey}
                            onSelectObject={onSelectObject}
                          />
                        ))}
                      </div>
                    );
                  })}
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
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: "100%",
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
      }}
    >
      <Chevron open={open} />
      {title}
    </button>
  );
}

function LibrarySessionRow({
  session,
  selected,
  onSelect,
}: {
  session: LibrarySessionSummary;
  selected: boolean;
  onSelect?: (session: LibrarySessionSummary) => void;
}) {
  return (
    <button
      type="button"
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
      <span style={{ fontSize: 12, fontWeight: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {session.title || "Untitled Library session"}
      </span>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "var(--text-dim)", fontSize: 11 }}>
        <span>{session.status}</span>
        <span>{session.detail ?? (typeof session.itemCount === "number" ? `${session.itemCount} items` : formatRelativeTime(session.modified))}</span>
      </span>
    </button>
  );
}

function DomainRow({
  label,
  selected,
  open,
  onSelect,
}: {
  label: string;
  selected: boolean;
  open: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        width: "100%",
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8,
        paddingRight: 8,
        border: "none",
        borderRadius: 5,
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 650,
        textAlign: "left",
      }}
    >
      <Chevron open={open} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
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
      <Chevron open={open} />
      <FolderIcon size={14} open={open} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
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
      }}
    >
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
