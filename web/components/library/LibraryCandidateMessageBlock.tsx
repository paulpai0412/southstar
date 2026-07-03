"use client";

import { useMemo, useState } from "react";
import type { LibraryImportCandidate, LibraryImportProposedEdge } from "@/lib/library/types";

export function LibraryCandidateMessageBlock({
  draftId,
  candidates,
  proposedEdges,
  status,
  onInstall,
}: {
  draftId: string;
  candidates: LibraryImportCandidate[];
  proposedEdges?: LibraryImportProposedEdge[];
  status: "draft" | "installing" | "installed";
  onInstall: (selectedCandidateIds: string[], selectedEdgeIds?: string[]) => void;
}) {
  const defaultSelected = useMemo(() => {
    const selected = candidates
      .filter((candidate) => candidate.selectedByDefault !== false)
      .map((candidate) => candidate.objectKey);
    return new Set(selected.length > 0 ? selected : candidates.map((candidate) => candidate.objectKey));
  }, [candidates]);
  const [selected, setSelected] = useState<Set<string>>(defaultSelected);
  const selectedIds = candidates
    .map((candidate) => candidate.objectKey)
    .filter((objectKey) => selected.has(objectKey));
  const allSelected = selectedIds.length === candidates.length && candidates.length > 0;

  return (
    <div data-testid="library-import-candidates" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700 }}>Import candidates</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{draftId}</div>
        </div>
        <button
          type="button"
          onClick={() => setSelected(allSelected ? new Set() : new Set(candidates.map((candidate) => candidate.objectKey)))}
          disabled={status !== "draft" || candidates.length === 0}
        >
          {allSelected ? "Unselect all" : "Select all"}
        </button>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {candidates.map((candidate) => (
          <label
            key={candidate.objectKey}
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              gap: 8,
              alignItems: "start",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(candidate.objectKey)}
              disabled={status !== "draft"}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.currentTarget.checked) {
                  next.add(candidate.objectKey);
                } else {
                  next.delete(candidate.objectKey);
                }
                setSelected(next);
              }}
              aria-label={`${candidate.title} ${candidate.objectKey}`}
            />
            <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <strong>{candidate.title}</strong>
                <span style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase" }}>{candidate.kind}</span>
                {typeof candidate.confidence === "number" ? (
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{candidate.confidence.toFixed(2)}</span>
                ) : null}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{candidate.objectKey}</span>
              {candidate.sourcePath ? (
                <span style={{ fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{candidate.sourcePath}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {proposedEdges && proposedEdges.length > 0 ? (
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <div style={{ color: "var(--text-dim)", fontWeight: 700 }}>Ontology edges</div>
          {proposedEdges.map((edge, index) => (
            <div key={`${edge.fromObjectKey}:${edge.edgeType}:${edge.toObjectKey}:${index}`} style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
              {edge.fromObjectKey} - {edge.edgeType}
              {typeof edge.confidence === "number" ? ` ${edge.confidence.toFixed(2)}` : ""} - {edge.toObjectKey}
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <button
          type="button"
          onClick={() => onInstall(selectedIds)}
          disabled={status !== "draft" || selectedIds.length === 0}
        >
          {status === "installed" ? "Installed" : status === "installing" ? "Installing..." : "Install selected"}
        </button>
      </div>
    </div>
  );
}
