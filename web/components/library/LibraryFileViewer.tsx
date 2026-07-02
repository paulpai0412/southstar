"use client";

export function LibraryFileViewer({
  content,
  onContentChange,
}: {
  content: string;
  onContentChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)", fontWeight: 700, fontSize: 12 }}>File Viewer</div>
      <textarea
        data-testid="library-file-editor"
        value={content}
        onChange={(event) => onContentChange(event.currentTarget.value)}
        style={{
          flex: 1,
          minHeight: 0,
          border: "none",
          resize: "none",
          padding: 12,
          fontFamily: "var(--font-mono)",
          background: "var(--bg)",
          color: "var(--text)",
        }}
      />
    </div>
  );
}
