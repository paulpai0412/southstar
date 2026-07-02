import type { LibraryPromptImportProposal } from "./prompt-library-importer.ts";
import { parseLibraryFileContent } from "../files/library-file-parser.ts";
import { projectLibraryFileToGraph, validateLibraryFileGraphReferences } from "../files/library-file-store.ts";

export function normalizeImportProposal(proposal: LibraryPromptImportProposal): LibraryPromptImportProposal {
  const seen = new Set<string>();
  const files = proposal.files.filter((file) => {
      if (seen.has(file.relativePath)) return false;
      seen.add(file.relativePath);
      return true;
    });
  const projections = files.map((file) => {
    const parsed = parseLibraryFileContent({ path: `library/${file.relativePath}`, content: file.content });
    if (!parsed.ok) return null;
    validateLibraryFileGraphReferences(parsed.file);
    return { relativePath: file.relativePath, file: parsed.file, projection: projectLibraryFileToGraph(parsed.file) };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  const objectKeys = [...new Set([
    ...proposal.objectKeys,
    ...projections.map((item) => item.projection.object.objectKey),
  ])].sort();

  return {
    files,
    objectKeys,
    objectSummaries: projections.map((item) => ({
      objectKey: item.projection.object.objectKey,
      objectKind: item.projection.object.objectKind,
      title: item.file.title,
      scope: item.file.scope,
      status: item.projection.object.status,
      relativePath: item.relativePath,
    })).sort((a, b) => a.objectKey.localeCompare(b.objectKey)),
    dependencies: projections.flatMap((item) => item.projection.edges.map((edge) => ({
      fromObjectKey: edge.fromObjectKey,
      edgeType: edge.edgeType,
      toObjectKey: edge.toObjectKey,
      scope: edge.scope,
    }))).sort((a, b) => (
      a.fromObjectKey.localeCompare(b.fromObjectKey)
      || a.edgeType.localeCompare(b.edgeType)
      || a.toObjectKey.localeCompare(b.toObjectKey)
    )),
  };
}
