export type LibraryImportProposal = {
  files: Array<{ relativePath: string; content: string }>;
  objectKeys: string[];
  objectSummaries: Array<{
    objectKey: string;
    objectKind: string;
    title: string;
    scope: string;
    status: string;
    relativePath: string;
  }>;
  dependencies: Array<{
    fromObjectKey: string;
    edgeType: string;
    toObjectKey: string;
    scope: string;
  }>;
};
