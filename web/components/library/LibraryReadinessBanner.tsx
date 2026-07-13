import type { LibraryReadinessView } from "@/lib/library/types";

export function LibraryReadinessBanner({ readiness }: { readiness: LibraryReadinessView }) {
  return (
    <section data-testid="library-readiness" aria-live="polite">
      <strong>{readiness.ready ? "Library ready" : "Library not ready"}</strong>
      <span>{readiness.snapshotHash ? readiness.snapshotHash.slice(0, 12) : "No successful snapshot"}</span>
      <span>{readiness.includedCount} included · {readiness.excludedCount} excluded</span>
      {readiness.diagnostics.map((diagnostic) => (
        <p key={`${diagnostic.code}:${diagnostic.paths.join("|")}`}>{diagnostic.message}</p>
      ))}
    </section>
  );
}
