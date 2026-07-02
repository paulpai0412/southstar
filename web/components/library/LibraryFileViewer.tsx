"use client";

import { useState } from "react";
import type { LibraryFileEnvelope, LibraryFileValidationIssue } from "@/lib/library/types";

type FileViewerTab = "Preview" | "Edit" | "Validate" | "Edges" | "Usage" | "Provenance";

const tabs: FileViewerTab[] = ["Preview", "Edit", "Validate", "Edges", "Usage", "Provenance"];

export function LibraryFileViewer({
  selectedFilePath,
  fileRecord,
  content,
  dirty,
  saving,
  syncing,
  issues,
  statusMessage,
  onContentChange,
  onSave,
  onSync,
}: {
  selectedFilePath?: string;
  fileRecord?: LibraryFileEnvelope | null;
  content: string;
  dirty: boolean;
  saving: boolean;
  syncing: boolean;
  issues?: LibraryFileValidationIssue[];
  statusMessage?: string;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onSync: () => void;
}) {
  const [activeTab, setActiveTab] = useState<FileViewerTab>("Edit");
  const visibleIssues = issues ?? fileRecord?.parsed.issues ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 12 }}>File Viewer</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selectedFilePath ?? "Select a library object"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              data-testid="library-file-save"
              disabled={!selectedFilePath || !dirty || saving}
              onClick={onSave}
              style={{ height: 28, fontSize: 12 }}
            >
              {saving ? "Saving" : "Save"}
            </button>
            <button
              type="button"
              data-testid="library-file-sync"
              disabled={!selectedFilePath || syncing || dirty}
              onClick={onSync}
              style={{ height: 28, fontSize: 12 }}
            >
              {syncing ? "Syncing" : "Sync"}
            </button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              style={{
                height: 26,
                padding: "0 7px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: activeTab === tab ? "var(--surface)" : "transparent",
                color: "var(--text)",
                fontSize: 11,
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        {statusMessage ? (
          <div
            data-testid="library-file-status"
            style={{
              marginTop: 8,
              padding: "6px 8px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 11,
              color: "var(--danger)",
              background: "var(--surface)",
            }}
          >
            {statusMessage}
          </div>
        ) : null}
        {visibleIssues.length > 0 ? (
          <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
            {visibleIssues.map((issue, index) => (
              <div key={`${issue.code}:${issue.path}:${index}`} style={{ fontSize: 11, color: issue.severity === "error" ? "var(--danger)" : "var(--text-muted)" }}>
                {issue.severity}: {issue.path} - {issue.message}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {activeTab === "Edit" ? (
          <textarea
            data-testid="library-file-editor"
            value={content}
            onChange={(event) => onContentChange(event.currentTarget.value)}
            placeholder="Select a library object with a source file..."
            style={{
              width: "100%",
              height: "100%",
              minHeight: 320,
              border: "none",
              resize: "none",
              padding: 12,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              background: "var(--bg)",
              color: "var(--text)",
              outline: "none",
            }}
          />
        ) : (
          <ReadOnlyPanel tab={activeTab} fileRecord={fileRecord ?? null} content={content} issues={visibleIssues} />
        )}
      </div>
    </div>
  );
}

function ReadOnlyPanel({
  tab,
  fileRecord,
  content,
  issues,
}: {
  tab: FileViewerTab;
  fileRecord: LibraryFileEnvelope | null;
  content: string;
  issues: LibraryFileValidationIssue[];
}) {
  const parsedFile = fileRecord?.parsed.ok ? fileRecord.parsed.file : null;
  let body: unknown;
  if (tab === "Preview") body = parsedFile ?? content;
  if (tab === "Validate") body = issues.length > 0 ? issues : [{ severity: "info", path: "$", message: "No validation issues", code: "ok" }];
  if (tab === "Edges") body = edgeRefs(parsedFile?.frontmatter);
  if (tab === "Usage") body = { objectKey: parsedFile?.objectKey, objectKind: parsedFile?.objectKind, scope: parsedFile?.scope };
  if (tab === "Provenance") body = { path: fileRecord?.relativePath, sourceHash: parsedFile?.sourceHash, status: parsedFile?.status };

  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--text)",
      }}
    >
      {typeof body === "string" ? body : JSON.stringify(body ?? {}, null, 2)}
    </pre>
  );
}

function edgeRefs(frontmatter: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!frontmatter) return {};
  const refs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key.endsWith("Refs") || key.endsWith("Ref")) refs[key] = value;
  }
  return refs;
}
