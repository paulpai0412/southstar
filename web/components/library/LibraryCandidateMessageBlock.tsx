"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CheckCheck, ChevronDown, ChevronUp, Download, Square } from "lucide-react";
import type { LibraryImportCandidate, LibraryImportCandidateCoverageTarget, LibraryImportProposedEdge } from "@/lib/library/types";

export function LibraryCandidateMessageBlock({
  draftId,
  candidates,
  candidateCoverageTargets,
  proposedEdges,
  status,
  installedObjectKeys,
  onInstall,
}: {
  draftId: string;
  candidates: LibraryImportCandidate[];
  candidateCoverageTargets?: LibraryImportCandidateCoverageTarget[];
  proposedEdges?: LibraryImportProposedEdge[];
  status: "draft" | "installing" | "installed";
  installedObjectKeys?: string[];
  onInstall: (selectedCandidateIds: string[], selectedEdgeIds?: string[]) => void;
}) {
  const installedKeys = useMemo(() => new Set(installedObjectKeys ?? []), [installedObjectKeys]);
  const selectableCandidates = useMemo(
    () => candidates.filter((candidate) => !installedKeys.has(candidate.objectKey)),
    [candidates, installedKeys],
  );
  const selectableCandidateKeys = useMemo(
    () => selectableCandidates.map((candidate) => candidate.objectKey),
    [selectableCandidates],
  );
  const proposalLocked = (candidateCoverageTargets?.length ?? 0) > 0;
  const defaultSelectedKeys = useMemo(() => {
    if (proposalLocked) return selectableCandidateKeys;
    const selected = selectableCandidates
      .filter((candidate) => candidate.selectedByDefault !== false)
      .map((candidate) => candidate.objectKey);
    return selected.length > 0 ? selected : selectableCandidateKeys;
  }, [proposalLocked, selectableCandidates, selectableCandidateKeys]);
  const selectionResetKey = `${selectableCandidateKeys.join("\u0000")}::${defaultSelectedKeys.join("\u0000")}`;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelectedKeys));
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setSelected((current) => {
      const selectableKeys = new Set(selectableCandidateKeys);
      const next = new Set([...current].filter((objectKey) => selectableKeys.has(objectKey)));
      if (next.size > 0 || selectableCandidateKeys.length === 0) return next;
      return new Set(defaultSelectedKeys);
    });
  }, [selectionResetKey]);

  const selectedIds = candidates
    .map((candidate) => candidate.objectKey)
    .filter((objectKey) => selected.has(objectKey) && !installedKeys.has(objectKey));
  const allSelected = selectedIds.length === selectableCandidates.length && selectableCandidates.length > 0;
  const isInstalling = status === "installing";
  const installDisabled = isInstalling || selectedIds.length === 0;

  return (
    <div
      data-testid="library-import-candidates"
      data-message-block="library-import-candidates"
      data-draft-id={draftId}
      style={{
        display: "grid",
        gap: 10,
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 10,
        background: "var(--bg-subtle)",
      }}
    >
      <div
        data-testid="library-import-candidates-toolbar"
        style={{ display: "grid", gap: 8 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span aria-hidden style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s", color: "var(--text-dim)" }}>›</span>
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>Import candidates</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{draftId}</div>
          </div>
        </div>
        <div
          data-testid="library-import-candidates-controls"
          style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 6, flexWrap: "wrap" }}
        >
          <IconButton
            label="Select all candidates"
            title="Select all"
            disabled={isInstalling || selectableCandidates.length === 0 || allSelected}
            onClick={() => setSelected(new Set(selectableCandidateKeys))}
          >
            <CheckCheck size={15} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Unselect all candidates"
            title="Unselect all"
            disabled={proposalLocked || isInstalling || selectedIds.length === 0}
            onClick={() => setSelected(new Set())}
          >
            <Square size={14} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Install selected candidates"
            title={isInstalling ? "Installing" : selectableCandidates.length === 0 && status === "installed" ? "Installed" : "Install selected"}
            disabled={installDisabled}
            onClick={() => onInstall(selectedIds)}
          >
            <Download size={15} strokeWidth={2} />
          </IconButton>
          <IconButton
            label={expanded ? "Hide candidates" : "Show candidates"}
            title={expanded ? "Hide candidates" : "Show candidates"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronUp size={15} strokeWidth={2} /> : <ChevronDown size={15} strokeWidth={2} />}
          </IconButton>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {selectedIds.length}/{selectableCandidates.length} selected
          </span>
          {proposalLocked ? <span data-testid="library-proposal-completeness" style={{ fontSize: 11, color: "var(--text-dim)" }}>Complete blocking-gap proposal · all candidates required</span> : null}
        </div>
      </div>
      {expanded ? (
        <div data-testid="library-import-candidates-list" style={{ display: "grid", gap: 6 }}>
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.objectKey}
              candidate={candidate}
              coverageTargets={candidateCoverageTargets?.filter((target) => target.candidateObjectKey === candidate.objectKey)}
              checked={selected.has(candidate.objectKey) && !installedKeys.has(candidate.objectKey)}
              disabled={proposalLocked || isInstalling || installedKeys.has(candidate.objectKey)}
              installed={installedKeys.has(candidate.objectKey)}
              onCheckedChange={(checked) => {
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) {
                    next.add(candidate.objectKey);
                  } else {
                    next.delete(candidate.objectKey);
                  }
                  return next;
                });
              }}
            />
          ))}
        </div>
      ) : null}
      {expanded && proposedEdges && proposedEdges.length > 0 ? (
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
    </div>
  );
}

function IconButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 30,
        height: 30,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg)",
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        opacity: disabled ? 0.48 : 1,
      }}
    >
      {children}
    </button>
  );
}

function CandidateRow({
  candidate,
  coverageTargets,
  checked,
  disabled,
  installed,
  onCheckedChange,
}: {
  candidate: LibraryImportCandidate;
  coverageTargets?: LibraryImportCandidateCoverageTarget[];
  checked: boolean;
  disabled: boolean;
  installed: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
          <label
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              gap: 8,
              alignItems: "start",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              background: "var(--bg)",
              opacity: installed ? 0.62 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={(event) => onCheckedChange(event.currentTarget.checked)}
              aria-label={`${candidate.title} ${candidate.objectKey}`}
            />
            <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <strong>{candidate.title}</strong>
                <span style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase" }}>{candidate.kind}</span>
                {typeof candidate.confidence === "number" ? (
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{candidate.confidence.toFixed(2)}</span>
                ) : null}
                {installed ? (
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Already installed</span>
                ) : null}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{candidate.objectKey}</span>
              {candidate.sourcePath ? (
                <span style={{ fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{candidate.sourcePath}</span>
              ) : null}
              {coverageTargets && coverageTargets.length > 0 ? (
                <span data-testid={`library-candidate-coverage-${candidate.objectKey}`} style={{ display: "grid", gap: 2, marginTop: 2 }}>
                  {coverageTargets.map((target) => (
                    <span key={`${target.gapRef}:${target.criterionIds.join(":")}`} style={{ fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                      Covers {target.requirementId} · {target.criterionIds.length > 0 ? target.criterionIds.join(", ") : target.gapRef}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          </label>
  );
}
