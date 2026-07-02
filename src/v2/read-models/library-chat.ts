export type LibraryChatBlock =
  | { type: "text"; text: string }
  | { type: "proposal"; title: string; objectKeys: string[]; filePaths: string[] }
  | { type: "graph"; title: string; scope: string; objectKeys: string[] }
  | { type: "validation"; ok: boolean; issues: Array<{ path: string; message: string }> };

export type LibraryChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  blocks: LibraryChatBlock[];
};

export type LibraryChatAction = {
  actionId: string;
  sessionId: string;
  prompt: string;
  scope: string;
};
