"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw, Search, Server, X } from "lucide-react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { WorkflowAgentSummary, WorkflowLibrary, WorkflowResource } from "@/lib/workflow/types";

type McpConfigProps = {
  open: boolean;
  onClose: () => void;
  cwd?: string | null;
};

type McpGrantListItem = {
  id: string;
  domainId: string;
  agent: WorkflowAgentSummary;
  path: string;
  label: string;
};

type GrantJson = {
  id?: string;
  transport?: string;
  serverId?: string;
  allowedTools?: string[];
  grants?: string[];
  enabled?: boolean;
};

function shortenPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function grantLabel(resourcePath: string): string {
  return resourcePath.split("/").at(-1)?.replace(/\.json$/, "") ?? resourcePath;
}

function parseGrantJson(content: string): GrantJson {
  try {
    const parsed = JSON.parse(content) as GrantJson;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function flattenMcpGrants(library: WorkflowLibrary | null): McpGrantListItem[] {
  if (!library) return [];
  return library.domains.flatMap((domain) =>
    domain.agents.flatMap((agent) =>
      agent.mcpResourcePaths.map((resourcePath) => ({
        id: `${agent.id}:${resourcePath}`,
        domainId: domain.id,
        agent,
        path: resourcePath,
        label: grantLabel(resourcePath),
      })),
    ),
  );
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}

function McpGrantDetail({
  item,
  cwd,
}: {
  item: McpGrantListItem;
  cwd?: string | null;
}) {
  const [resource, setResource] = useState<WorkflowResource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadResource = useCallback(() => {
    setLoading(true);
    setError(null);
    setResource(null);
    const encoded = encodeFilePathForApi(item.path);
    const url = `/api/workflow/resources/${encoded}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
    fetch(url)
      .then((response) => response.json().then((body: { resource?: WorkflowResource; error?: string }) => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!body.resource) throw new Error("MCP grant resource not found");
        setResource(body.resource);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [cwd, item.path]);

  useEffect(() => {
    loadResource();
  }, [loadResource]);

  const grant = parseGrantJson(resource?.content ?? "{}");
  const allowed = grant.allowedTools ?? grant.grants ?? [];
  const enabled = grant.enabled !== false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            background: enabled ? "rgba(34,197,94,0.12)" : "rgba(120,120,120,0.12)",
            color: enabled ? "#16a34a" : "var(--text-dim)",
            flexShrink: 0,
          }}
        >
          {enabled ? "enabled" : "disabled"}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {shortenPath(item.path)}
        </span>
        <button
          type="button"
          title="Copy path"
          onClick={() => {
            void copyText(item.path).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          style={{
            marginLeft: "auto",
            height: 26,
            width: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: copied ? "var(--bg-selected)" : "transparent",
            color: copied ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>Agent</span>
          <span style={{ fontSize: 14, color: "var(--text)" }}>{item.agent.label}</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{item.agent.defaultProfileRef}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>Grant</span>
          <span style={{ fontSize: 14, color: "var(--text)" }}>{grant.id ?? grant.serverId ?? item.label}</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{grant.transport ?? "task-scoped"}</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>Allowed tools</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {allowed.length > 0 ? allowed.map((tool) => (
            <span
              key={tool}
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                padding: "2px 6px",
                background: "var(--bg-panel)",
              }}
            >
              {tool}
            </span>
          )) : (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>No explicit tool list</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>Resource JSON</span>
          <button
            type="button"
            title="Refresh"
            onClick={loadResource}
            style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, fontSize: 11, border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", padding: "3px 7px", cursor: "pointer" }}
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</div>
        ) : error ? (
          <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>
        ) : (
          <pre
            style={{
              margin: 0,
              minHeight: 180,
              maxHeight: "36vh",
              overflow: "auto",
              padding: 12,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {resource?.content ?? "{}"}
          </pre>
        )}
      </div>
    </div>
  );
}

export function McpConfig({ open, onClose, cwd }: McpConfigProps) {
  const [library, setLibrary] = useState<WorkflowLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");

  const loadLibrary = useCallback(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch(`/api/workflow/library${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
      .then((response) => response.json().then((body: { library?: WorkflowLibrary; error?: string }) => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
        const next = body.library ?? { domains: [] };
        setLibrary(next);
        const grants = flattenMcpGrants(next);
        setSelected((current) => current && grants.some((grant) => grant.id === current) ? current : (grants[0]?.id ?? null));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [cwd, open]);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const grants = useMemo(() => flattenMcpGrants(library), [library]);
  const filtered = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return grants;
    return grants.filter((grant) =>
      [
        grant.label,
        grant.path,
        grant.domainId,
        grant.agent.label,
        grant.agent.role,
        grant.agent.defaultProfileRef,
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [filterText, grants]);
  const selectedGrant = grants.find((grant) => grant.id === selected) ?? filtered[0] ?? null;

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MCP config"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          width: 860,
          height: "78vh",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>MCP</span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {cwd ? shortenPath(cwd) : "workflow library"}
            </code>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "2px 6px", display: "flex", alignItems: "center" }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
          <div style={{ width: 240, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)" }}>
            <div style={{ padding: 8, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6 }}>
              <Search size={14} color="var(--text-dim)" />
              <input
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder="Search grants"
                style={{ minWidth: 0, flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--text)", fontSize: 12 }}
              />
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>Loading...</div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#f87171" }}>{error}</div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>No MCP grants found</div>
              ) : (
                library?.domains.map((domain) => {
                  const domainGrants = filtered.filter((grant) => grant.domainId === domain.id);
                  if (domainGrants.length === 0) return null;
                  return (
                    <div key={domain.id} style={{ marginBottom: 8 }}>
                      <div style={{ padding: "4px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {domain.label}
                      </div>
                      {domainGrants.map((grant) => {
                        const isSelected = selectedGrant?.id === grant.id;
                        return (
                          <button
                            key={grant.id}
                            type="button"
                            onClick={() => setSelected(grant.id)}
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "8px 8px",
                              border: "none",
                              borderRadius: 5,
                              cursor: "pointer",
                              background: isSelected ? "var(--bg-selected)" : "transparent",
                              color: isSelected ? "var(--text)" : "var(--text-muted)",
                              textAlign: "left",
                            }}
                          >
                            <Server size={13} style={{ flexShrink: 0 }} />
                            <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: isSelected ? 650 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {grant.label}
                              </span>
                              <span style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {grant.agent.label}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              <button
                type="button"
                onClick={loadLibrary}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "7px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
              >
                <RefreshCw size={13} />
                Refresh
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {selectedGrant ? (
              <McpGrantDetail key={selectedGrant.id} item={selectedGrant} cwd={cwd} />
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                Select an MCP grant
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            {grants.length} task-scoped MCP grant{grants.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={onClose}
            style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
