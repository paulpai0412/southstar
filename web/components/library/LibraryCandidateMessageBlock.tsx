"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CheckCheck, ChevronDown, ChevronUp, Download, Square } from "lucide-react";
import type { LibraryImportCandidate, LibraryImportCandidateCoverageTarget, LibraryImportProposedEdge, LibraryImportSourceDocument } from "@/lib/library/types";
import { LibraryGraphChart, selectGraphNeighborhood, type LibraryGraphChartEdge, type LibraryGraphChartNode, type LibraryGraphSelectionGraph } from "./LibraryGraphChart";

export function LibraryCandidateMessageBlock({
  draftId,
  candidates,
  candidateCoverageTargets,
  proposedEdges,
  documents,
  status,
  installedObjectKeys,
  onInstall,
  onSelectNode,
}: {
  draftId: string;
  candidates: LibraryImportCandidate[];
  candidateCoverageTargets?: LibraryImportCandidateCoverageTarget[];
  proposedEdges?: LibraryImportProposedEdge[];
  documents?: LibraryImportSourceDocument[];
  status: "draft" | "installing" | "installed";
  installedObjectKeys?: string[];
  onInstall: (selectedCandidateIds: string[], selectedEdgeIds?: string[]) => void;
  onSelectNode?: (node: LibraryGraphChartNode) => void;
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
  const coverageGraph = candidateCoverageTargets && candidateCoverageTargets.length > 0
    ? buildCandidateCoverageGraph(candidates, candidateCoverageTargets, proposedEdges, installedObjectKeys, documents)
    : undefined;

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
        <details data-testid="library-import-guide" style={importGuideStyle}>
          <summary style={importGuideSummaryStyle}>How to choose and import Library candidates</summary>
          <div style={importGuideBodyStyle}>
            <div><strong>Candidate title</strong> is the readable capability; the object key is the technical identity used for graph sync.</div>
            <div><strong>Semantic tags</strong> describe the reusable outcome vocabulary. Confirm them before installing; they are later checked against each confirmed Requirement and are not a blanket approval for every Goal.</div>
            <div><strong>Covers</strong> lines show which requirement and criterion the candidate closes. Select candidates only when their capability and scope fit the goal.</div>
            <div>Install selected candidates to write them into the approved Library graph. A complete blocking-gap proposal may require all candidates and will keep selection locked.</div>
          </div>
        </details>
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
              documents={documents}
              selectionGraph={coverageGraph ? selectGraphNeighborhood(coverageGraph, candidate.objectKey) : undefined}
              onSelectNode={onSelectNode}
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
      {candidateCoverageTargets && candidateCoverageTargets.length > 0 ? (
        <CandidateCoveragePreview
          draftId={draftId}
          candidates={candidates}
          coverageTargets={candidateCoverageTargets}
          graph={coverageGraph!}
          onSelectNode={onSelectNode}
        />
      ) : null}
    </div>
  );
}

function CandidateCoveragePreview({
  draftId,
  candidates,
  coverageTargets,
  graph,
  onSelectNode,
}: {
  draftId: string;
  candidates: LibraryImportCandidate[];
  coverageTargets: LibraryImportCandidateCoverageTarget[];
  graph: LibraryGraphSelectionGraph;
  onSelectNode?: (node: LibraryGraphChartNode) => void;
}) {
  const requirementIds = new Set(coverageTargets.map((target) => target.requirementId));
  const criterionIds = new Set(coverageTargets.flatMap((target) => target.criterionIds));

  return (
    <section data-testid="candidate-coverage-preview" style={{ display: "grid", gap: 7, paddingTop: 2 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>Candidate coverage preview</strong>
        <span data-testid="candidate-coverage-summary" style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {requirementIds.size} requirement{requirementIds.size === 1 ? "" : "s"} · {criterionIds.size} AC · {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        Proposal only: installing a candidate does not create runtime lineage until the Goal Contract and workflow are persisted.
      </div>
      <LibraryGraphChart
        nodes={graph.nodes}
        edges={graph.edges}
        onSelectNode={(node) => onSelectNode?.({
          ...node,
          selectionGraph: selectGraphNeighborhood(graph, node.objectKey),
        })}
        persistLayoutKey={`candidate-coverage:${draftId}`}
      />
    </section>
  );
}

function buildCandidateCoverageGraph(
  candidates: LibraryImportCandidate[],
  coverageTargets: LibraryImportCandidateCoverageTarget[],
  proposedEdges: LibraryImportProposedEdge[] | undefined,
  installedObjectKeys: string[] | undefined,
  documents: LibraryImportSourceDocument[] | undefined,
): { nodes: LibraryGraphChartNode[]; edges: LibraryGraphChartEdge[] } {
  const installedKeys = new Set(installedObjectKeys ?? []);
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.objectKey, candidate]));
  const sourceRequirements = sourceRequirementRecords(documents);
  const nodes = new Map<string, LibraryGraphChartNode>();
  const edges: LibraryGraphChartEdge[] = [];
  const edgeKeys = new Set<string>();

  const addNode = (node: LibraryGraphChartNode) => {
    if (!nodes.has(node.objectKey)) nodes.set(node.objectKey, node);
  };
  const addEdge = (edge: LibraryGraphChartEdge) => {
    const key = `${edge.fromObjectKey}:${edge.edgeType}:${edge.toObjectKey}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  candidates.forEach((candidate) => addNode({
    objectKey: candidate.objectKey,
    title: candidate.title,
    objectKind: candidate.kind,
    status: installedKeys.has(candidate.objectKey) ? "installed" : "proposed",
    sourcePath: candidate.sourcePath,
    sourceContent: sourceDocumentForCandidate(candidate, documents)?.content,
    metadata: candidate as unknown as Record<string, unknown>,
  }));

  coverageTargets.forEach((target) => {
    const requirementKey = `requirement:${target.requirementId}`;
    const candidate = candidatesByKey.get(target.candidateObjectKey);
    const missingCandidate = !candidate;
    const requirement = sourceRequirements.find((item) => item.id === target.requirementId);
    addNode({
      objectKey: requirementKey,
      title: `Requirement ${target.requirementId}`,
      objectKind: "requirement",
      status: missingCandidate ? "blocked" : "proposed",
      metadata: requirementMetadata(requirement, target.requirementId),
    });

    const criterionIds = target.criterionIds.length > 0 ? target.criterionIds : [`gap:${target.gapRef}`];
    const candidateKey = candidate?.objectKey ?? `candidate:missing:${target.candidateObjectKey}`;
    if (missingCandidate) {
      addNode({
        objectKey: candidateKey,
        title: `Missing candidate · ${target.candidateObjectKey}`,
        objectKind: "candidate",
        status: "blocked",
      });
    }

    criterionIds.forEach((criterionId) => {
      const criterionKey = `ac:${target.requirementId}:${criterionId}`;
      const criterion = criterionForRequirement(requirement, criterionId);
      addNode({
        objectKey: criterionKey,
        title: `AC ${criterionId}`,
        objectKind: "acceptance_criteria",
        status: missingCandidate ? "blocked" : "proposed",
        metadata: criterionMetadata(criterion, requirement, criterionId),
      });
      addEdge({ fromObjectKey: requirementKey, toObjectKey: criterionKey, edgeType: "has criterion" });
      addEdge({ fromObjectKey: criterionKey, toObjectKey: candidateKey, edgeType: "candidate covers" });
    });
  });

  proposedEdges?.forEach((edge) => {
    addNode({ objectKey: edge.fromObjectKey, title: edge.fromObjectKey, objectKind: "ontology", status: "proposed" });
    addNode({ objectKey: edge.toObjectKey, title: edge.toObjectKey, objectKind: "ontology", status: "proposed" });
    addEdge({
      fromObjectKey: edge.fromObjectKey,
      toObjectKey: edge.toObjectKey,
      edgeType: edge.edgeType,
      ontology: { confidence: edge.confidence, rationale: edge.rationale },
    });
  });

  return { nodes: [...nodes.values()], edges };
}

type SourceRecord = Record<string, unknown>;

function sourceRequirementRecords(documents: LibraryImportSourceDocument[] | undefined): SourceRecord[] {
  const content = documents?.[0]?.content?.trim();
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const requirements = (parsed as SourceRecord).requirements;
    return Array.isArray(requirements)
      ? requirements.filter((item): item is SourceRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
  } catch {
    return [];
  }
}

function requirementMetadata(requirement: SourceRecord | undefined, requirementId: string): Record<string, unknown> {
  if (!requirement) return { description: `No Requirement statement was supplied for ${requirementId}.` };
  return pickContentFields(requirement, ["id"]);
}

function criterionForRequirement(requirement: SourceRecord | undefined, criterionId: string): SourceRecord | undefined {
  const intents = requirement?.criterionIntent;
  if (!Array.isArray(intents)) return undefined;
  return intents.find((item): item is SourceRecord => Boolean(item && typeof item === "object" && !Array.isArray(item) && (item as SourceRecord).id === criterionId));
}

function criterionMetadata(criterion: SourceRecord | undefined, requirement: SourceRecord | undefined, criterionId: string): Record<string, unknown> {
  if (criterion) return pickContentFields(criterion, ["id"]);
  const acceptanceCriteria = Array.isArray(requirement?.acceptanceCriteria) ? requirement.acceptanceCriteria : [];
  return {
    statement: acceptanceCriteria.length === 1 ? acceptanceCriteria[0] : `No acceptance criterion statement was supplied for ${criterionId}.`,
  };
}

function pickContentFields(record: SourceRecord, omittedKeys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omittedKeys.includes(key)));
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
  documents,
  selectionGraph,
  onSelectNode,
  onCheckedChange,
}: {
  candidate: LibraryImportCandidate;
  coverageTargets?: LibraryImportCandidateCoverageTarget[];
  checked: boolean;
  disabled: boolean;
  installed: boolean;
  documents?: LibraryImportSourceDocument[];
  selectionGraph?: LibraryGraphSelectionGraph;
  onSelectNode?: (node: LibraryGraphChartNode) => void;
  onCheckedChange: (checked: boolean) => void;
}) {
  const sourceDocument = sourceDocumentForCandidate(candidate, documents);
  return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr) auto",
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
              {candidate.semanticTags && candidate.semanticTags.length > 0 ? (
                <span data-testid={`library-candidate-semantic-tags-${candidate.objectKey}`} style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                  Semantic coverage: {candidate.semanticTags.join(" · ")}
                </span>
              ) : (
                <span data-testid={`library-candidate-semantic-tags-${candidate.objectKey}`} style={{ fontSize: 11, color: "#fbbf24", overflowWrap: "anywhere" }}>
                  Semantic coverage: missing — do not install for a tagged Requirement
                </span>
              )}
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
            {onSelectNode ? (
              <button
                type="button"
                aria-label={`View ${candidate.title}`}
                onClick={() => onSelectNode({
                  objectKey: candidate.objectKey,
                  objectKind: candidate.kind,
                  status: installed ? "installed" : "proposed",
                  title: candidate.title,
                  sourcePath: candidate.sourcePath,
                  sourceContent: sourceDocument?.content,
                  metadata: candidate as unknown as Record<string, unknown>,
                  selectionGraph,
                })}
                style={{ alignSelf: "start", whiteSpace: "nowrap", fontSize: 11 }}
              >
                View
              </button>
            ) : null}
          </div>
  );
}

function sourceDocumentForCandidate(
  candidate: LibraryImportCandidate,
  documents?: LibraryImportSourceDocument[],
): LibraryImportSourceDocument | undefined {
  if (!candidate.sourcePath) return undefined;
  return documents?.find((document) => document.path === candidate.sourcePath || document.path.endsWith(`/${candidate.sourcePath}`));
}

const importGuideStyle = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.45,
} as const;

const importGuideSummaryStyle = { cursor: "pointer", padding: "6px 8px", color: "var(--text)" } as const;
const importGuideBodyStyle = { display: "grid", gap: 5, padding: "0 8px 8px" } as const;
