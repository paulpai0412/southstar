"use client";

import { useCallback, useEffect, useState } from "react";
import { unwrapEnvelope } from "@/lib/library/api";
import type { LibraryWorkspaceModel } from "@/lib/library/types";
import { LibraryChatWindow } from "./LibraryChatWindow";
import { LibraryFileViewer } from "./LibraryFileViewer";
import { LibrarySidebar } from "./LibrarySidebar";

export function LibraryWorkspace() {
  const [model, setModel] = useState<LibraryWorkspaceModel | null>(null);
  const [selectedScope, setSelectedScope] = useState("software");
  const [quickPrompt, setQuickPrompt] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [fileContent, setFileContent] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/library/workspace?scope=${encodeURIComponent(selectedScope)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setModel(unwrapEnvelope<LibraryWorkspaceModel>(payload));
      })
      .catch(() => {
        if (!cancelled) setModel({ selectedScope, domains: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedScope]);

  const handlePromptSubmit = useCallback(() => {
    const text = quickPrompt.trim();
    if (!text) return;
    setPendingPrompt(text);
    setQuickPrompt("");
  }, [quickPrompt]);

  const handlePromptConsumed = useCallback(() => {
    setPendingPrompt("");
  }, []);

  return (
    <div
      data-testid="library-workspace"
      style={{
        display: "grid",
        gridTemplateColumns: "260px minmax(0, 1fr) 360px",
        height: "100%",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <aside
        data-testid="library-sidebar"
        style={{ borderRight: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}
      >
        <LibrarySidebar
          model={model}
          selectedScope={selectedScope}
          onSelectScope={setSelectedScope}
          prompt={quickPrompt}
          onPromptChange={setQuickPrompt}
          onPromptSubmit={handlePromptSubmit}
        />
      </aside>
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden" }}>
        <LibraryChatWindow
          scope={selectedScope}
          pendingPrompt={pendingPrompt}
          onPromptConsumed={handlePromptConsumed}
        />
      </main>
      <aside
        data-testid="library-file-viewer"
        style={{ borderLeft: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}
      >
        <LibraryFileViewer content={fileContent} onContentChange={setFileContent} />
      </aside>
    </div>
  );
}
