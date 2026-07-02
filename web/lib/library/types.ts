export type LibrarySseEvent =
  | "library.chat.delta"
  | "library.intent.started"
  | "library.intent.completed"
  | "library.import.fetching"
  | "library.import.parsing"
  | "library.llm_extract.delta"
  | "library.proposal.created"
  | "library.graph.diff"
  | "library.validation.completed"
  | "library.file.saved"
  | "library.db.synced"
  | "library.graph.snapshot"
  | "library.command.completed"
  | "library.error";

export type LibrarySseFrame = {
  event: LibrarySseEvent | string;
  data: Record<string, unknown>;
};

export type LibraryWorkspaceModel = {
  selectedScope: string;
  domains: Array<{
    scope: string;
    counts: Record<string, number>;
    objects: Array<{
      objectKey: string;
      objectKind: string;
      status: string;
      title: string;
    }>;
  }>;
};
