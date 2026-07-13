import { libraryFileReferences, listLibraryFiles, readLibraryFile } from "./library-file-store.ts";
import type { LibraryFileRecord } from "./library-file-types.ts";

export type LibraryFileDiagnostic = {
  code:
    | "parse_invalid"
    | "duplicate_object_key"
    | "missing_reference"
    | "required_purpose_cardinality"
    | "required_purpose_content";
  message: string;
  fatal: boolean;
  paths: string[];
  objectKey?: string;
  missingRefs: string[];
};

export type LibraryFileCatalog = {
  root: string;
  records: LibraryFileRecord[];
  diagnostics: LibraryFileDiagnostic[];
};

export type ClosedApprovedLibraryFileSet = {
  included: LibraryFileRecord[];
  excluded: Array<LibraryFileDiagnostic & { objectKey: string }>;
  diagnostics: LibraryFileDiagnostic[];
};

export async function loadLibraryFileCatalog(input: { root: string }): Promise<LibraryFileCatalog> {
  const entries = await listLibraryFiles(input);
  const reads = await Promise.all(
    entries.map((entry) => readLibraryFile({ root: input.root, relativePath: entry.relativePath })),
  );
  const records: LibraryFileRecord[] = [];
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const read of reads) {
    if (read.parsed.ok) {
      records.push(read.parsed.file);
      continue;
    }
    diagnostics.push({
      code: "parse_invalid",
      message: read.parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      fatal: read.parsed.metadata?.status === "approved" || read.parsed.metadata?.status === undefined,
      paths: [`library/${read.relativePath}`],
      objectKey: read.parsed.metadata?.objectKey,
      missingRefs: [],
    });
  }
  return {
    root: input.root,
    records: records.sort((a, b) => a.path.localeCompare(b.path)),
    diagnostics,
  };
}

export function resolveClosedApprovedLibraryFileSet(records: LibraryFileRecord[]): ClosedApprovedLibraryFileSet {
  const byKey = new Map<string, LibraryFileRecord[]>();
  for (const record of records) {
    byKey.set(record.objectKey, [...(byKey.get(record.objectKey) ?? []), record]);
  }

  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const [objectKey, matches] of byKey) {
    if (matches.length > 1) {
      diagnostics.push({
        code: "duplicate_object_key",
        message: `duplicate Library object key ${objectKey}`,
        fatal: true,
        paths: matches.map((item) => item.path).sort(),
        objectKey,
        missingRefs: [],
      });
    }
  }
  if (diagnostics.length > 0) return { included: [], excluded: [], diagnostics };

  const approved = records.filter((record) => record.status === "approved");
  const candidates = new Map(approved.map((record) => [record.objectKey, record]));
  const missingByKey = new Map<string, string[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [objectKey, record] of [...candidates]) {
      const missing = libraryFileReferences(record).filter((ref) => !candidates.has(ref));
      if (missing.length === 0) continue;
      candidates.delete(objectKey);
      missingByKey.set(objectKey, missing);
      changed = true;
    }
  }

  const excluded = approved
    .filter((record) => !candidates.has(record.objectKey))
    .map((record) => ({
      code: "missing_reference" as const,
      message: `${record.objectKey} is excluded because required references are not in the approved closed set`,
      fatal: false,
      paths: [record.path],
      objectKey: record.objectKey,
      missingRefs: missingByKey.get(record.objectKey)
        ?? libraryFileReferences(record).filter((ref) => !candidates.has(ref)),
    }))
    .sort((a, b) => a.objectKey.localeCompare(b.objectKey));

  return {
    included: [...candidates.values()].sort((a, b) => a.objectKey.localeCompare(b.objectKey)),
    excluded,
    diagnostics,
  };
}

export function validateRequiredLibraryPurposes(records: LibraryFileRecord[]): LibraryFileDiagnostic[] {
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const purpose of ["goal_design", "composer_guidance"] as const) {
    const matches = records.filter(
      (record) => record.objectKind === "skill_spec" && record.definition.purpose === purpose,
    );
    if (matches.length !== 1) {
      diagnostics.push({
        code: "required_purpose_cardinality",
        message: `expected exactly one approved ${purpose} skill, found ${matches.length}`,
        fatal: true,
        paths: matches.map((item) => item.path),
        missingRefs: [],
      });
      continue;
    }
    if (!matches[0]!.body.trim()) {
      diagnostics.push({
        code: "required_purpose_content",
        message: `${purpose} skill must contain a non-empty instruction body`,
        fatal: true,
        paths: [matches[0]!.path],
        objectKey: matches[0]!.objectKey,
        missingRefs: [],
      });
    }
  }
  return diagnostics;
}
