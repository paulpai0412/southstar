import type { LibraryDefinitionKind, LibraryDefinitionStatus, LibraryEdgeType } from "../types.ts";

export type LibraryFileKind = "agent" | "skill" | "tool" | "mcp" | "generated_profile" | "workflow_template";

export type LibraryFileStatus = Extract<LibraryDefinitionStatus, "draft" | "approved" | "deprecated" | "blocked"> | "invalid";

export type LibraryFileRecord = {
  path: string;
  kind: LibraryFileKind;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  id: string;
  title: string;
  scope: string;
  status: LibraryFileStatus;
  schemaVersion: string;
  frontmatter: Record<string, unknown>;
  definition: Record<string, unknown>;
  body: string;
  sourceHash: string;
};

export type LibraryFileValidationIssue = {
  severity: "info" | "warning" | "error";
  path: string;
  message: string;
  code: string;
};

export type LibraryFileParseResult =
  | { ok: true; file: LibraryFileRecord; issues: LibraryFileValidationIssue[] }
  | { ok: false; issues: LibraryFileValidationIssue[] };

export type LibraryFileGraphProjection = {
  object: {
    objectKey: string;
    objectKind: LibraryDefinitionKind;
    status: LibraryDefinitionStatus;
    headVersionId: string;
    state: Record<string, unknown>;
  };
  edges: Array<{
    fromObjectKey: string;
    edgeType: LibraryEdgeType;
    toObjectKey: string;
    scope: string;
    metadata: Record<string, unknown>;
  }>;
};
