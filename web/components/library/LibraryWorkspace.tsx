"use client";

export function LibraryWorkspace() {
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
        Library
      </aside>
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden" }}>
        Library chat
      </main>
      <aside
        data-testid="library-file-viewer"
        style={{ borderLeft: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}
      >
        File viewer
      </aside>
    </div>
  );
}
