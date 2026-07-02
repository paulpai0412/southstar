"use client";

import type { LibraryWorkspaceModel, LibraryWorkspaceObject, LibraryWorkspaceObjectGroup } from "@/lib/library/types";

export function LibrarySidebar({
  model,
  selectedScope,
  selectedObjectKey,
  statusFilter,
  onSelectScope,
  onStatusFilterChange,
  onSelectObject,
  prompt,
  onPromptChange,
  onPromptSubmit,
}: {
  model: LibraryWorkspaceModel | null;
  selectedScope: string;
  selectedObjectKey?: string;
  statusFilter: string;
  onSelectScope: (scope: string) => void;
  onStatusFilterChange: (status: string) => void;
  onSelectObject: (object: LibraryWorkspaceObject) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptSubmit: () => void;
}) {
  const domains = model?.domains ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Library</div>
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
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
          Status
        </label>
        <select
          data-testid="library-status-filter"
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.currentTarget.value)}
          style={{
            width: "100%",
            height: 28,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 12,
          }}
        >
          <option value="all">All</option>
          <option value="draft">Draft</option>
          <option value="approved">Approved</option>
          <option value="deprecated">Deprecated</option>
          <option value="blocked">Blocked</option>
        </select>
      </div>
      <div style={{ overflow: "auto", padding: 8 }}>
        {domains.map((domain) => (
          <section key={domain.scope} style={{ marginBottom: 10 }}>
            <button
              onClick={() => onSelectScope(domain.scope)}
              aria-pressed={selectedScope === domain.scope}
              style={{ width: "100%", textAlign: "left", fontWeight: 700 }}
            >
              {domain.scope}
            </button>
            {Object.entries(domain.counts).map(([kind, count]) => (
              <div
                key={`${domain.scope}:${kind}`}
                style={{ display: "flex", justifyContent: "space-between", padding: "3px 8px", fontSize: 12, color: "var(--text-muted)" }}
              >
                <span>{kind}</span>
                <span>{count}</span>
              </div>
            ))}
            {objectGroupsForDomain(domain)
              .map((group) => ({
                ...group,
                objects: group.objects.filter((object) => statusFilter === "all" || object.status === statusFilter),
              }))
              .filter((group) => group.objects.length > 0)
              .map((group) => (
                <div key={`${domain.scope}:${group.objectKind}:objects`} style={{ marginTop: 8 }}>
                  <div
                    style={{
                      padding: "4px 8px",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                    }}
                  >
                    {group.objectKind}
                  </div>
                  {group.objects.map((object) => {
                    const selected = selectedObjectKey === object.objectKey;
                    return (
                      <button
                        key={object.objectKey}
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
                  })}
                </div>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
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
