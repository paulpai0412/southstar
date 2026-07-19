"use client";

import { useMemo, useState } from "react";
import type {
  LibraryFileEnvelope,
  LibraryFileRecord,
  LibraryFileValidationIssue,
  LibraryGraphReadModel,
  LibraryObjectDetail,
} from "@/lib/library/types";
import { LibraryGraphChart, prepareGraphNodeSelection, type LibraryGraphChartNode } from "./LibraryGraphChart";

type FileViewerTab = "Edges" | "Preview" | "Edit" | "Validate" | "Usage";

const tabs: FileViewerTab[] = ["Edges", "Preview", "Edit", "Validate", "Usage"];
const validStatuses = new Set(["draft", "approved", "deprecated", "blocked", "invalid"]);

export function LibraryFileViewer({
  selectedFilePath,
  fileRecord,
  objectDetail,
  edgeGraph,
  content,
  dirty,
  saving,
  syncing,
  issues,
  statusMessage,
  onContentChange,
  onSaveAndSync,
  onSelectGraphNode,
}: {
  selectedFilePath?: string;
  fileRecord?: LibraryFileEnvelope | null;
  objectDetail?: LibraryObjectDetail | null;
  edgeGraph?: LibraryGraphReadModel | null;
  content: string;
  dirty: boolean;
  saving: boolean;
  syncing: boolean;
  issues?: LibraryFileValidationIssue[];
  statusMessage?: string;
  onContentChange: (value: string) => void;
  onSaveAndSync: () => void;
  onSelectGraphNode?: (node: LibraryGraphChartNode) => void;
}) {
  const [activeTab, setActiveTab] = useState<FileViewerTab>("Edges");
  const effectiveActiveTab = selectedFilePath || !objectDetail ? activeTab : activeTab === "Edit" ? "Preview" : activeTab;
  const parsedFile = fileRecord?.parsed.ok ? fileRecord.parsed.file : null;
  const validationIssues = useMemo(
    () => currentValidationIssues({ selectedFilePath, content, dirty, fileRecord: fileRecord ?? null, providedIssues: issues }),
    [content, dirty, fileRecord, issues, selectedFilePath],
  );
  const hasValidationErrors = validationIssues.some((issue) => issue.severity === "error");
  const saveDisabled = !selectedFilePath || !dirty || saving || syncing || hasValidationErrors;
  const graph = edgeGraph ?? fallbackGraphFromObjectDetail(objectDetail, parsedFile);

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
          <button
            type="button"
            data-testid="library-file-save-sync"
            disabled={saveDisabled}
            onClick={onSaveAndSync}
            style={{ height: 28, fontSize: 12, whiteSpace: "nowrap" }}
          >
            {saving ? "Saving" : syncing ? "Syncing" : "Save & Sync"}
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={effectiveActiveTab === tab}
              onClick={() => setActiveTab(tab)}
              style={{
                height: 26,
                padding: "0 7px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: effectiveActiveTab === tab ? "var(--surface)" : "transparent",
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
        {validationIssues.length > 0 ? (
          <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
            {validationIssues.slice(0, 3).map((issue, index) => (
              <div key={`${issue.code}:${issue.path}:${index}`} data-testid="library-file-line-issue" style={{ fontSize: 11, color: issue.severity === "error" ? "var(--danger)" : "var(--text-muted)" }}>
                {formatLineIssue(issue)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {effectiveActiveTab === "Edit" ? (
          <div style={{ display: "grid", gridTemplateRows: validationIssues.length > 0 ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)", height: "100%", minHeight: 320 }}>
            {validationIssues.length > 0 ? (
              <ValidationIssueList issues={validationIssues} compact />
            ) : null}
            <textarea
              data-testid="library-file-editor"
              value={content}
              onChange={(event) => onContentChange(event.currentTarget.value)}
              placeholder="Select a library object with a source file..."
              style={{
                width: "100%",
                height: "100%",
                minHeight: 260,
                border: "none",
                borderTop: validationIssues.length > 0 ? "1px solid var(--border)" : "none",
                resize: "none",
                padding: 12,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                background: "var(--bg)",
                color: "var(--text)",
                outline: "none",
              }}
            />
          </div>
        ) : effectiveActiveTab === "Edges" ? (
          <EdgesPanel graph={graph} objectDetail={objectDetail ?? null} parsedFile={parsedFile} selectedFilePath={selectedFilePath} content={content} onSelectGraphNode={onSelectGraphNode} />
        ) : effectiveActiveTab === "Preview" ? (
          <PreviewPanel fileRecord={fileRecord ?? null} objectDetail={objectDetail ?? null} content={content} />
        ) : effectiveActiveTab === "Validate" ? (
          <ValidationPanel issues={validationIssues} />
        ) : (
          <UsagePanel objectDetail={objectDetail ?? null} parsedFile={parsedFile} />
        )}
      </div>
    </div>
  );
}

function EdgesPanel({
  graph,
  objectDetail,
  parsedFile,
  selectedFilePath,
  content,
  onSelectGraphNode,
}: {
  graph: LibraryGraphReadModel | null;
  objectDetail: LibraryObjectDetail | null;
  parsedFile: LibraryFileRecord | null;
  selectedFilePath?: string;
  content: string;
  onSelectGraphNode?: (node: LibraryGraphChartNode) => void;
}) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  return (
    <div style={{ padding: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
        <span>{nodes.length} nodes / {edges.length} edges</span>
        <span>{graph?.activeScope ?? parsedFile?.scope ?? stringValue(objectDetail?.object.state?.scope) ?? "all"}</span>
      </div>
      {nodes.length > 0 ? (
        <LibraryGraphChart
          nodes={nodes}
          edges={edges}
          onSelectNode={(node) => onSelectGraphNode?.(
            node.viewOnly
              ? prepareGraphNodeSelection({ activeScope: graph?.activeScope, nodes, edges }, node)
              : node,
          )}
          persistLayoutKey={`file-viewer:${objectDetail?.object.objectKey ?? parsedFile?.objectKey ?? "unknown"}`}
        />
      ) : (
        <section style={{ display: "grid", gap: 6, fontSize: 12 }}>
          <div style={{ fontWeight: 700 }}>No graph edges</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
            {JSON.stringify(objectDetail ? { inboundEdges: objectDetail.inboundEdges, outboundEdges: objectDetail.outboundEdges } : edgeRefs(parsedFile?.frontmatter), null, 2)}
          </pre>
        </section>
      )}
      <NodeContentPanel objectDetail={objectDetail} parsedFile={parsedFile} content={content} />
      {selectedFilePath ? (
        <section data-testid="library-file-content-preview" style={{ display: "grid", gap: 5 }}>
          <strong style={{ fontSize: 12 }}>Source content · {selectedFilePath}</strong>
          <pre style={{ margin: 0, padding: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 11, background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 6 }}>
            {content || "(empty source file)"}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function NodeContentPanel({
  objectDetail,
  parsedFile,
  content,
}: {
  objectDetail: LibraryObjectDetail | null;
  parsedFile: LibraryFileRecord | null;
  content: string;
}) {
  const state = objectDetail?.object.state ?? {};
  const parsedContent = parsedFile ? { ...(parsedFile.frontmatter ?? {}), ...(parsedFile.definition ?? {}) } : parseStructuredContent(content);
  const stateHasContent = Object.keys(state).some((key) => !isTechnicalContentKey(key) && key !== "title");
  const record = stateHasContent ? { ...parsedContent, ...state } : { ...parseStructuredContent(content), ...parsedContent, ...state };
  const title = stringValue(record.title)
    ?? parsedFile?.title
    ?? objectDetail?.object.objectKind
    ?? "Selected node";
  const summary = stringValue(record.statement)
    ?? stringValue(record.description)
    ?? stringValue(record.responsibility)
    ?? firstBodyParagraph(parsedFile?.body ?? "");
  const entries = Object.entries(record).filter(([key, value]) => (
    key !== "title" && key !== "statement" && key !== "description" && key !== "responsibility" && value !== undefined && !isTechnicalContentKey(key)
  ));

  return (
    <section data-testid="library-node-content" style={{ display: "grid", gap: 7 }}>
      <strong style={{ fontSize: 12 }}>Node content · {title}</strong>
      {summary ? <p style={{ margin: 0, lineHeight: 1.5, fontSize: 12 }}>{summary}</p> : null}
      {entries.length > 0 ? (
        <dl style={{ display: "grid", gap: 7, margin: 0, fontSize: 12 }}>
          {entries.map(([key, value]) => (
            <div key={key} style={{ display: "grid", gap: 3 }}>
              <dt style={{ color: "var(--text-muted)", fontWeight: 650 }}>{humanizeContentKey(key)}</dt>
              <dd style={{ margin: 0 }}><NormalizedContentValue value={value} /></dd>
            </div>
          ))}
        </dl>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No structured node content</span>
      )}
    </section>
  );
}

function NormalizedContentValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return value.length > 0 ? (
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
        {value.map((item, index) => <li key={index}><NormalizedContentValue value={item} /></li>)}
      </ul>
    ) : <span style={{ color: "var(--text-muted)" }}>None</span>;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !isTechnicalContentKey(key));
    return entries.length > 0 ? (
      <div style={{ display: "grid", gap: 4, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
        {entries.map(([key, nestedValue]) => (
          <div key={key}>
            <span style={{ color: "var(--text-muted)" }}>{humanizeContentKey(key)}: </span>
            <NormalizedContentValue value={nestedValue} />
          </div>
        ))}
      </div>
    ) : <span style={{ color: "var(--text-muted)" }}>None</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (value === null || value === undefined || value === "") return <span style={{ color: "var(--text-muted)" }}>None</span>;
  return <span>{String(value)}</span>;
}

function parseStructuredContent(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    const frontmatter = markdownFrontmatter(content);
    if (frontmatter.issues.length > 0) return {};
    return Object.fromEntries(parseTopLevelYaml(frontmatter.content, frontmatter.offset).values);
  }
}

function isTechnicalContentKey(key: string): boolean {
  return key === "id"
    || key === "objectKey"
    || key === "sourcePath"
    || key === "sourceHash"
    || key === "headVersionId"
    || key === "schemaVersion"
    || key.endsWith("Hash")
    || key.endsWith("Ref")
    || key.endsWith("Refs");
}

function humanizeContentKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase());
}

function PreviewPanel({
  fileRecord,
  objectDetail,
  content,
}: {
  fileRecord: LibraryFileEnvelope | null;
  objectDetail: LibraryObjectDetail | null;
  content: string;
}) {
  const parsedFile = fileRecord?.parsed.ok ? fileRecord.parsed.file : null;
  const object = objectDetail?.object;
  const title = stringValue(object?.state?.title) ?? parsedFile?.title ?? object?.objectKey ?? "No object selected";
  const summary = stringValue(object?.state?.description)
    ?? nestedStringValue(object?.state, ["runtimeRole", "responsibility"])
    ?? firstBodyParagraph(parsedFile?.body ?? content);
  const fields = [
    ["Object key", object?.objectKey ?? parsedFile?.objectKey],
    ["Kind", object?.objectKind ?? parsedFile?.objectKind],
    ["Status", object?.status ?? parsedFile?.status],
    ["Scope", stringValue(object?.state?.scope) ?? parsedFile?.scope],
    ["Source path", fileRecord?.relativePath ?? stringValue(object?.state?.sourcePath)],
    ["Head version", object?.headVersionId],
    ["Source hash", parsedFile?.sourceHash],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);

  return (
    <div data-testid="library-file-preview" style={{ padding: 12, display: "grid", gap: 12 }}>
      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
        {summary ? <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 }}>{summary}</p> : null}
      </section>
      <dl style={{ display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", gap: "7px 10px", margin: 0, fontSize: 12 }}>
        {fields.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt style={{ color: "var(--text-muted)" }}>{label}</dt>
            <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere", fontFamily: label.includes("hash") || label.includes("key") ? "var(--font-mono)" : undefined }}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ValidationPanel({ issues }: { issues: LibraryFileValidationIssue[] }) {
  return (
    <div data-testid="library-validation-panel" style={{ padding: 12 }}>
      {issues.length > 0 ? (
        <ValidationIssueList issues={issues} />
      ) : (
        <div style={{ fontSize: 12, color: "var(--success, #0f766e)" }}>No validation issues</div>
      )}
    </div>
  );
}

function ValidationIssueList({ issues, compact = false }: { issues: LibraryFileValidationIssue[]; compact?: boolean }) {
  return (
    <div style={{ display: "grid", gap: compact ? 4 : 8, padding: compact ? 8 : 0 }}>
      {issues.map((issue, index) => (
        <div
          key={`${issue.code}:${issue.path}:${index}`}
          data-testid="library-file-line-issue"
          style={{
            borderLeft: `3px solid ${issue.severity === "error" ? "var(--danger)" : "var(--warning, #b54708)"}`,
            padding: "5px 8px",
            background: "var(--surface)",
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 700 }}>{formatLineIssue(issue)}</div>
          <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{issue.code}</div>
        </div>
      ))}
    </div>
  );
}

function UsagePanel({
  objectDetail,
  parsedFile,
}: {
  objectDetail: LibraryObjectDetail | null;
  parsedFile: LibraryFileRecord | null;
}) {
  const usage = objectDetail?.usage;
  const usedBy = usage?.usedByObjectKeys ?? [];
  const dependsOn = usage?.dependsOnObjectKeys ?? [];
  return (
    <div data-testid="library-usage-panel" style={{ padding: 12, display: "grid", gap: 14, fontSize: 12 }}>
      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>Used by</h3>
        {usedBy.length > 0 ? usedBy.map((key) => <code key={key}>{key}</code>) : <span style={{ color: "var(--text-muted)" }}>No inbound usage</span>}
      </section>
      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>Depends on</h3>
        {dependsOn.length > 0 ? dependsOn.map((key) => <code key={key}>{key}</code>) : <span style={{ color: "var(--text-muted)" }}>No outbound dependencies</span>}
      </section>
      <section style={{ display: "grid", gridTemplateColumns: "112px 1fr", gap: "6px 10px" }}>
        <span style={{ color: "var(--text-muted)" }}>Object</span>
        <code>{objectDetail?.object.objectKey ?? parsedFile?.objectKey ?? "none"}</code>
        <span style={{ color: "var(--text-muted)" }}>Inbound</span>
        <span>{usage?.inboundCount ?? objectDetail?.inboundEdges.length ?? 0}</span>
        <span style={{ color: "var(--text-muted)" }}>Outbound</span>
        <span>{usage?.outboundCount ?? objectDetail?.outboundEdges.length ?? 0}</span>
      </section>
    </div>
  );
}

function currentValidationIssues(input: {
  selectedFilePath?: string;
  content: string;
  dirty: boolean;
  fileRecord: LibraryFileEnvelope | null;
  providedIssues?: LibraryFileValidationIssue[];
}): LibraryFileValidationIssue[] {
  if (input.dirty && input.selectedFilePath) {
    return validateLibraryFileContent(input.selectedFilePath, input.content);
  }
  if (input.providedIssues) return withLineNumbers(input.providedIssues, input.content);
  return withLineNumbers(input.fileRecord?.parsed.issues ?? [], input.content);
}

function validateLibraryFileContent(relativePath: string, content: string): LibraryFileValidationIssue[] {
  const yaml = relativePath.endsWith(".md") ? markdownFrontmatter(content) : { content, offset: 0, issues: [] };
  if (yaml.issues.length > 0) return yaml.issues;
  const parsed = parseTopLevelYaml(yaml.content, yaml.offset);
  const issues = [...parsed.issues];
  for (const key of ["schemaVersion", "id", "title", "scope", "status"]) {
    if (!parsed.values.has(key)) {
      issues.push(lineIssue("error", key, `${key} is required`, `${key}_required`, 1));
    }
  }
  const status = parsed.values.get("status");
  if (status && !validStatuses.has(status)) {
    issues.push(lineIssue("error", "status", `status is not supported: ${status}`, "status_unsupported", parsed.lines.get("status") ?? 1));
  }
  return issues;
}

function markdownFrontmatter(content: string): { content: string; offset: number; issues: LibraryFileValidationIssue[] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    return {
      content: "",
      offset: 0,
      issues: [lineIssue("error", "$", "markdown library file must start with YAML frontmatter", "frontmatter_required", 1)],
    };
  }
  return { content: match[1] ?? "", offset: 1, issues: [] };
}

function parseTopLevelYaml(content: string, lineOffset: number): {
  values: Map<string, string>;
  lines: Map<string, number>;
  issues: LibraryFileValidationIssue[];
} {
  const values = new Map<string, string>();
  const lines = new Map<string, number>();
  const issues: LibraryFileValidationIssue[] = [];
  const rawLines = content.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || raw.startsWith(" ")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      issues.push(lineIssue("error", "$", "YAML entries must use key: value syntax", "yaml_key_value_required", lineOffset + index + 1));
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    values.set(key, value);
    lines.set(key, lineOffset + index + 1);
  }
  return { values, lines, issues };
}

function withLineNumbers(issues: LibraryFileValidationIssue[], content: string): LibraryFileValidationIssue[] {
  return issues.map((issue) => {
    if (issue.path.match(/^line \d+ /)) return issue;
    return { ...issue, path: `line ${lineForPath(content, issue.path)} / ${issue.path}` };
  });
}

function lineForPath(content: string, path: string): number {
  const key = path.split(".").at(-1)?.replace(/[^A-Za-z0-9_-]/g, "");
  if (!key) return 1;
  const lines = content.split(/\r?\n/);
  const found = lines.findIndex((line) => line.trimStart().startsWith(`${key}:`));
  return found >= 0 ? found + 1 : 1;
}

function lineIssue(
  severity: LibraryFileValidationIssue["severity"],
  path: string,
  message: string,
  code: string,
  line: number,
): LibraryFileValidationIssue {
  return { severity, path: `line ${line} / ${path}`, message, code };
}

function formatLineIssue(issue: LibraryFileValidationIssue): string {
  return `${issue.severity}: ${issue.path} - ${issue.message}`;
}

function fallbackGraphFromObjectDetail(
  objectDetail: LibraryObjectDetail | null | undefined,
  parsedFile: LibraryFileRecord | null,
): LibraryGraphReadModel | null {
  const objectKey = objectDetail?.object.objectKey ?? parsedFile?.objectKey;
  if (!objectKey) return null;
  const objectNode = {
    objectKey,
    objectKind: objectDetail?.object.objectKind ?? parsedFile?.objectKind,
    status: objectDetail?.object.status ?? parsedFile?.status,
    title: stringValue(objectDetail?.object.state?.title) ?? parsedFile?.title ?? objectKey,
    scope: stringValue(objectDetail?.object.state?.scope) ?? parsedFile?.scope,
  };
  const edges = [...(objectDetail?.inboundEdges ?? []), ...(objectDetail?.outboundEdges ?? [])];
  const nodeKeys = new Set([objectKey]);
  for (const edge of edges) {
    nodeKeys.add(edge.fromObjectKey);
    nodeKeys.add(edge.toObjectKey);
  }
  const nodes = [...nodeKeys].map((key) => key === objectKey ? objectNode : {
    objectKey: key,
    title: key,
  });
  return {
    activeScope: objectNode.scope,
    nodes,
    edges,
  };
}

function edgeRefs(frontmatter: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!frontmatter) return {};
  const refs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key.endsWith("Refs") || key.endsWith("Ref")) refs[key] = value;
  }
  return refs;
}

function firstBodyParagraph(content: string): string | undefined {
  const paragraph = content
    .split(/\n{2,}/)
    .map((chunk) => chunk.replace(/^#+\s*/gm, "").trim())
    .find((chunk) => chunk.length > 0);
  if (!paragraph) return undefined;
  return paragraph.length > 220 ? `${paragraph.slice(0, 217)}...` : paragraph;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedStringValue(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return stringValue(current);
}
