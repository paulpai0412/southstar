import { createHash } from "node:crypto";
import type { LibraryDefinitionKind } from "../types.ts";
import type {
  LibraryFileKind,
  LibraryFileParseResult,
  LibraryFileRecord,
  LibraryFileValidationIssue,
} from "./library-file-types.ts";

type ParsedContent =
  | { ok: true; data: Record<string, unknown>; body: string }
  | { ok: false; issues: LibraryFileValidationIssue[] };

const OBJECT_ARRAY_KEYS = new Set(["nodes", "edges"]);

const FILE_FORMATS: Array<{
  suffix: string;
  kind: LibraryFileKind;
  objectKind: LibraryDefinitionKind;
  schemaVersion: string;
}> = [
  {
    suffix: ".agent.md",
    kind: "agent",
    objectKind: "agent_definition",
    schemaVersion: "southstar.library.agent_definition_file.v1",
  },
  {
    suffix: ".skill.md",
    kind: "skill",
    objectKind: "skill_spec",
    schemaVersion: "southstar.library.skill_spec_file.v1",
  },
  {
    suffix: ".tool.yaml",
    kind: "tool",
    objectKind: "tool_definition",
    schemaVersion: "southstar.library.tool_definition_file.v1",
  },
  {
    suffix: ".mcp.yaml",
    kind: "mcp",
    objectKind: "mcp_tool_grant",
    schemaVersion: "southstar.library.mcp_grant_file.v1",
  },
  {
    suffix: ".profile.yaml",
    kind: "generated_profile",
    objectKind: "agent_profile",
    schemaVersion: "southstar.library.generated_agent_profile_file.v1",
  },
  {
    suffix: ".workflow.yaml",
    kind: "workflow_template",
    objectKind: "workflow_template",
    schemaVersion: "southstar.library.workflow_template_file.v1",
  },
];

const VALID_STATUSES = new Set<LibraryFileRecord["status"]>(["draft", "approved", "deprecated", "blocked", "invalid"]);

export function parseLibraryFileContent(input: { path: string; content: string }): LibraryFileParseResult {
  const format = FILE_FORMATS.find((candidate) => input.path.endsWith(candidate.suffix));
  if (!format) {
    return { ok: false, issues: [error("path", `unsupported library file path: ${input.path}`, "unsupported_file_type")] };
  }

  const parsed = input.path.endsWith(".md")
    ? parseMarkdownWithFrontmatter(input.content)
    : parseSimpleYaml(input.content);
  if (!parsed.ok) return parsed;

  const issues: LibraryFileValidationIssue[] = [];
  const schemaVersion = stringValue(parsed.data.schemaVersion);
  const id = stringValue(parsed.data.id);
  const title = stringValue(parsed.data.title);
  const scope = stringValue(parsed.data.scope);
  const status = stringValue(parsed.data.status);

  if (!schemaVersion) {
    issues.push(error("schemaVersion", "schemaVersion is required", "schema_required"));
  } else if (schemaVersion !== format.schemaVersion) {
    issues.push(error("schemaVersion", `schemaVersion must be ${format.schemaVersion}`, "schema_unsupported"));
  }

  if (!id) issues.push(error("id", "id is required", "id_required"));
  if (!title) issues.push(error("title", "title is required", "title_required"));
  if (!scope) issues.push(error("scope", "scope is required", "scope_required"));
  if (!status) {
    issues.push(error("status", "status is required", "status_required"));
  } else if (!VALID_STATUSES.has(status as LibraryFileRecord["status"])) {
    issues.push(error("status", `status is not supported: ${status}`, "status_unsupported"));
  }

  if (issues.some((issue) => issue.severity === "error")) return { ok: false, issues };

  const definition = { ...parsed.data };
  const file: LibraryFileRecord = {
    path: input.path,
    kind: format.kind,
    objectKey: id!,
    objectKind: format.objectKind,
    id: id!,
    title: title!,
    scope: scope!,
    status: status! as LibraryFileRecord["status"],
    schemaVersion: schemaVersion!,
    frontmatter: parsed.data,
    definition,
    body: parsed.body,
    sourceHash: hash(input.content),
  };

  return { ok: true, file, issues };
}

function parseMarkdownWithFrontmatter(content: string): ParsedContent {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    return {
      ok: false,
      issues: [error("$", "markdown library file must start with YAML frontmatter", "frontmatter_required")],
    };
  }

  const frontmatter = match[1] ?? "";
  const parsed = parseSimpleYamlObject(frontmatter);
  if (parsed.issues.length > 0) return { ok: false, issues: parsed.issues };

  return {
    ok: true,
    data: parsed.data,
    body: content.slice(match[0].length),
  };
}

function parseSimpleYaml(content: string): ParsedContent {
  const parsed = parseSimpleYamlObject(content);
  if (parsed.issues.length > 0) return { ok: false, issues: parsed.issues };
  return { ok: true, data: parsed.data, body: "" };
}

function parseSimpleYamlObject(content: string): { data: Record<string, unknown>; issues: LibraryFileValidationIssue[] } {
  const root: Record<string, unknown> = {};
  const issues: LibraryFileValidationIssue[] = [];
  const lines = content.split(/\r?\n/);
  let currentArrayKey: string | null = null;
  let currentArrayObject: Record<string, unknown> | null = null;
  let currentObjectKey: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index]!;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (line.startsWith("  - ") && currentArrayKey) {
      const item = line.slice(4).trim();
      const entry = parseKeyValue(item);
      if (entry) {
        currentArrayObject = { [entry.key]: scalar(entry.value) };
        (root[currentArrayKey] as Array<unknown>).push(currentArrayObject);
      } else if (OBJECT_ARRAY_KEYS.has(currentArrayKey)) {
        currentArrayObject = null;
        issues.push(error(currentArrayKey, `${currentArrayKey} list items must be key/value objects`, "yaml_object_array_item_invalid"));
      } else {
        currentArrayObject = null;
        (root[currentArrayKey] as Array<unknown>).push(scalar(item));
      }
      continue;
    }

    if (line.startsWith("    ") && currentArrayKey && currentArrayObject) {
      const entry = parseKeyValue(trimmed);
      if (!entry) continue;
      currentArrayObject[entry.key] = scalar(entry.value);
      continue;
    }

    if (line.startsWith("  ") && currentObjectKey) {
      const entry = parseKeyValue(trimmed);
      if (!entry) continue;
      (root[currentObjectKey] as Record<string, unknown>)[entry.key] = scalar(entry.value);
      continue;
    }

    const entry = parseKeyValue(line);
    if (!entry) continue;

    currentArrayKey = null;
    currentArrayObject = null;
    currentObjectKey = null;

    if (entry.value === "") {
      const nextLine = nextContentLine(lines, index)?.trimStart();
      if (nextLine === "[]") {
        root[entry.key] = [];
      } else if (nextLine?.startsWith("- ")) {
        root[entry.key] = [];
        currentArrayKey = entry.key;
      } else {
        root[entry.key] = {};
        currentObjectKey = entry.key;
      }
      continue;
    }

    root[entry.key] = scalar(entry.value);
  }

  return { data: root, issues };
}

function nextContentLine(lines: string[], currentIndex: number): string | undefined {
  for (let index = currentIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() && !line.trimStart().startsWith("#")) return line;
  }
  return undefined;
}

function parseKeyValue(line: string): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) return undefined;
  const key = line.slice(0, separatorIndex).trim();
  if (!key) return undefined;
  return { key, value: line.slice(separatorIndex + 1).trim() };
}

function scalar(value: string): string | boolean | number | [] {
  if (value === "[]") return [];
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function error(path: string, message: string, code: string): LibraryFileValidationIssue {
  return { severity: "error", path, message, code };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
