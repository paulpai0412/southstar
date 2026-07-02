"use client";

import type { LibraryWorkspaceModel } from "@/lib/library/types";

export function LibrarySidebar({
  model,
  selectedScope,
  onSelectScope,
  prompt,
  onPromptChange,
  onPromptSubmit,
}: {
  model: LibraryWorkspaceModel | null;
  selectedScope: string;
  onSelectScope: (scope: string) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptSubmit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Library</div>
        <textarea
          data-testid="library-quick-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder="Import or create library item..."
          rows={3}
          style={{
            width: "100%",
            resize: "vertical",
            fontSize: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text)",
            padding: 8,
          }}
        />
        <button
          data-testid="library-quick-prompt-submit"
          onClick={onPromptSubmit}
          disabled={!prompt.trim()}
          style={{ marginTop: 8, width: "100%", height: 28 }}
        >
          Send to Library chat
        </button>
      </div>
      <div style={{ overflow: "auto", padding: 8 }}>
        {(model?.domains ?? []).map((domain) => (
          <section key={domain.scope} style={{ marginBottom: 10 }}>
            <button
              onClick={() => onSelectScope(domain.scope)}
              aria-pressed={selectedScope === domain.scope}
              style={{ width: "100%", textAlign: "left", fontWeight: 700 }}
            >
              {domain.scope}
            </button>
            {Object.entries(domain.counts).map(([kind, count]) => (
              <div
                key={`${domain.scope}:${kind}`}
                style={{ display: "flex", justifyContent: "space-between", padding: "3px 8px", fontSize: 12, color: "var(--text-muted)" }}
              >
                <span>{kind}</span>
                <span>{count}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
