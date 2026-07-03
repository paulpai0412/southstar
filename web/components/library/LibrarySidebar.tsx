"use client";

import { useState } from "react";
import type { LibrarySessionSummary, LibraryWorkspaceModel, LibraryWorkspaceObject, LibraryWorkspaceObjectGroup } from "@/lib/library/types";

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
  onSelectObject,
  prompt,
  onPromptChange,
  onPromptSubmit,
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
  onSelectObject: (object: LibraryWorkspaceObject) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptSubmit: () => void;
}) {
  const domains = model?.domains ?? [];
  const [domainFilter, setDomainFilter] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(true);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const normalizedDomainFilter = domainFilter.trim().toLowerCase();
  const filteredDomains = normalizedDomainFilter
    ? domains.filter((domain) => domain.scope.toLowerCase().includes(normalizedDomainFilter))
    : domains;
  const isOpen = (key: string) => openMap[key] ?? true;
  const toggle = (key: string) => setOpenMap((current) => ({ ...current, [key]: !(current[key] ?? true) }));

  return (
    <div data-testid="library-sidebar-content" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
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

      <div style={{ padding: 10, borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <textarea
          data-testid="library-quick-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder="Import or create library item..."
          rows={3}
          style={{
            width: "100%",
            resize: "vertical",
            fontSize: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text)",
            padding: 8,
          }}
        />
        <button
          data-testid="library-quick-prompt-submit"
          onClick={onPromptSubmit}
          disabled={!prompt.trim()}
          style={{ marginTop: 8, width: "100%", height: 28 }}
        >
          Send to Library chat
        </button>
      </div>
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
      <span style={{ color: "var(--text-muted)", width: 14 }}>[]</span>
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
    <span aria-hidden="true" style={{ width: 12, display: "inline-flex", justifyContent: "center", color: "var(--text-dim)" }}>
      {open ? "v" : ">"}
    </span>
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
