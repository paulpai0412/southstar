import type { LibraryPromptImportProposal } from "./prompt-library-importer.ts";

export function normalizeImportProposal(proposal: LibraryPromptImportProposal): LibraryPromptImportProposal {
  const seen = new Set<string>();
  return {
    files: proposal.files.filter((file) => {
      if (seen.has(file.relativePath)) return false;
      seen.add(file.relativePath);
      return true;
    }),
    objectKeys: [...new Set(proposal.objectKeys)].sort(),
  };
}
