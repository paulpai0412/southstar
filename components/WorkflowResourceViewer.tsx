"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { WorkflowResource } from "@/lib/workflow/types";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { StructuredJsonEditor } from "./StructuredJsonEditor";

function workflowResourceUrl(resourcePath: string, cwd?: string | null): string {
  const encoded = encodeFilePathForApi(resourcePath);
  return `/api/workflow/resources/${encoded}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
}

export function WorkflowResourceViewer({
  resourcePath,
  cwd,
}: {
  resourcePath: string;
  cwd?: string | null;
}) {
  const [resource, setResource] = useState<WorkflowResource | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return fetch(workflowResourceUrl(resourcePath, cwd))
      .then((res) => res.json().then((data: { resource?: WorkflowResource; error?: string }) => ({ res, data })))
      .then(({ res, data }) => {
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!data.resource) throw new Error("Workflow resource not found");
        setResource(data.resource);
        setDraft(data.resource.content);
        setEditing(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [cwd, resourcePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const jsonError = useMemo(() => {
    if (!resource || resource.kind !== "json") return null;
    try {
      JSON.parse(draft);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [draft, resource]);

  const dirty = resource ? draft !== resource.content : false;

  const save = async () => {
    if (!resource || jsonError) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(workflowResourceUrl(resourcePath), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, content: draft }),
      });
      const data = await res.json() as { resource?: WorkflowResource; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (!data.resource) throw new Error("Workflow resource not found");
      setResource(data.resource);
      setDraft(data.resource.content);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return <div data-testid="workflow-resource-viewer" style={{ padding: 16, color: "#f87171", fontSize: 13 }}>{error}</div>;
  }

  if (!resource) {
    return <div data-testid="workflow-resource-viewer" style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;
  }

  return (
    <div data-testid="workflow-resource-viewer" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", fontSize: 11 }}>
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {resource.path}
        </span>
        <span style={{ marginLeft: "auto" }}>{resource.kind}</span>
        <button data-testid="resource-edit" onClick={() => setEditing(true)} style={{ fontSize: 11 }}>
          Edit
        </button>
        <button data-testid="resource-reset" onClick={() => setDraft(resource.content)} disabled={!dirty} style={{ fontSize: 11 }}>
          Reset
        </button>
        <button data-testid="resource-save" onClick={() => void save()} disabled={!dirty || !!jsonError || saving} style={{ fontSize: 11 }}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {resource.kind === "markdown" ? (
          <RichMarkdownEditor value={draft} onChange={setDraft} readOnly={!editing} />
        ) : (
          <StructuredJsonEditor value={draft} onChange={setDraft} readOnly={!editing} />
        )}
      </div>
    </div>
  );
}
