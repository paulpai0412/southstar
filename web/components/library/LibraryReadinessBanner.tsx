import type { LibraryReadinessView } from "@/lib/library/types";

export function LibraryReadinessBanner({ readiness }: { readiness: LibraryReadinessView }) {
  const diagnosticCount = readiness.diagnostics.length;
  return (
    <section
      data-testid="library-readiness"
      aria-live="polite"
      style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "grid", gap: 4, fontSize: 11 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <strong>{readiness.ready ? "Library ready" : "Library not ready"}</strong>
        {readiness.snapshotHash ? <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{readiness.snapshotHash.slice(0, 12)}</span> : null}
      </div>
      <span style={{ color: "var(--text-muted)" }}>{readiness.includedCount} included · {readiness.excludedCount} excluded</span>
      {diagnosticCount > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>{diagnosticCount} excluded item{diagnosticCount === 1 ? "" : "s"} · view diagnostics</summary>
          <div style={{ maxHeight: 220, overflow: "auto", display: "grid", gap: 6, marginTop: 6 }}>
            {readiness.diagnostics.map((diagnostic) => (
              <p key={`${diagnostic.code}:${diagnostic.paths.join("|")}`} style={{ margin: 0 }}>
                {diagnostic.message}
                {diagnostic.paths.length > 0 ? ` (${diagnostic.paths.join(", ")})` : ""}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
