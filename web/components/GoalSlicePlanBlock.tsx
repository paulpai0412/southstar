"use client";

import { useEffect, useMemo, useState } from "react";
import type { GoalDesignContent, GoalDesignPhase, GoalRequirementsContent, GoalSliceSelection } from "@/lib/types";
import { CoverageGraphPreview, type CoverageGraphData } from "./CoverageGraphPreview";
import type { LibraryGraphChartEdge, LibraryGraphChartNode } from "./library/LibraryGraphChart";
import { readCurrentGoalDesignDraft } from "@/lib/workflow/goal-design-draft";

type GoalSliceView = {
  id: string;
  requirementIds: string[];
  outcome: string;
  stateOrArtifactOwner: string;
  mutationBoundary: string;
  expectedArtifactRefs: string[];
  evaluatorContractRefs: string[];
  dependsOnSliceIds: string[];
  dependencyArtifactRefs: string[];
  mergeReason?: string;
};

type CriterionBindingView = {
  artifactContractRef: string;
  evaluatorProfileRef: string;
};

type ValidationBindingView = {
  id: string;
  requirementId: string;
  criterionBindings: CriterionBindingView[];
};

type GoalDesignPackageView = {
  revision?: number;
  packageHash?: string;
  goalContract?: { summary?: string };
  validationBindings: ValidationBindingView[];
  slicePlan?: { slices?: GoalSliceView[] };
  compositionStrategy?: { mode?: string; rationale?: string };
  templatePolicy?: { mode?: string; templateRef?: string; versionRef?: string };
};

type LiveDraftView = Pick<GoalDesignContent, "status" | "goalDesignPhase" | "goalDesignPackageHash" | "goalRequirementDraft" | "goalRequirementDraftHash" | "package">;

export function GoalSlicePlanBlock({
  block,
  requirementContent,
  onSliceSelect,
  onConfirmGoalDesign,
  onCreateGoalSliceRevision,
  onLibraryGraphNodeSelect,
}: {
  block: GoalDesignContent;
  requirementContent?: GoalRequirementsContent | null;
  onSliceSelect?: (selection: GoalSliceSelection) => void;
  onConfirmGoalDesign?: (selection: GoalSliceSelection) => void;
  onCreateGoalSliceRevision?: (selection: GoalSliceSelection) => void | Promise<void>;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
}) {
  const [livePhase, setLivePhase] = useState<GoalDesignPhase | undefined>(block.goalDesignPhase);
  const [liveDraft, setLiveDraft] = useState<LiveDraftView | null>(null);
  const stagedRevision = block.draftId.includes(":slice-revision:");
  const [liveDraftState, setLiveDraftState] = useState<"not-needed" | "loading" | "ready" | "error">(
    stagedRevision ? "loading" : "not-needed",
  );
  const [revisionState, setRevisionState] = useState<"idle" | "creating" | "error">("idle");
  const [revisionError, setRevisionError] = useState<string | undefined>();
  const currentPackage = liveDraft?.package ?? block.package;
  const pkg = goalDesignPackageView(currentPackage);
  const slices = pkg?.slicePlan?.slices ?? [];
  const requirementContentForBlock = requirementContent?.draftId === block.draftId ? requirementContent : null;
  const requirementDraft = liveDraft?.goalRequirementDraft ?? requirementContentForBlock?.draft ?? block.goalRequirementDraft;
  const phase = liveDraft?.goalDesignPhase ?? livePhase ?? block.goalDesignPhase;
  const status = liveDraft?.status ?? block.status;
  const requirementContentForGraph = requirementContentForBlock ?? (requirementDraft ? {
    type: "goalRequirements" as const,
    draftId: block.draftId,
    status: phase ?? status ?? "slice_review",
    goalRequirementDraftHash: liveDraft?.goalRequirementDraftHash ?? block.goalRequirementDraftHash ?? requirementDraft.draftHash,
    draft: requirementDraft,
    confirmable: false,
  } : null);
  const packageHash = liveDraft?.goalDesignPackageHash ?? block.goalDesignPackageHash ?? pkg?.packageHash;
  const strategyMode = pkg?.compositionStrategy?.mode ?? "unknown";
  const templateMode = pkg?.templatePolicy?.mode ?? "auto";
  const phaseKnown = Boolean(phase);
  const frozen = phase === "composing" || phase === "dag_validated";
  const liveRevisionReady = !stagedRevision || liveDraftState === "ready";
  const coverageGraph = useMemo(
    () => buildSliceCoverageGraph(slices, requirementContentForGraph, pkg),
    [pkg, requirementContentForGraph, slices],
  );

  useEffect(() => {
    if (block.goalDesignPhase && !stagedRevision) return;
    let active = true;
    setLiveDraftState("loading");
    void readCurrentGoalDesignDraft(block.draftId)
      .then((current) => {
        if (!active) return;
        const next: LiveDraftView = {
          ...(current.status ? { status: current.status } : {}),
          ...(current.goalDesignPhase ? { goalDesignPhase: current.goalDesignPhase } : {}),
          goalDesignPackageHash: current.goalDesignPackageHash,
          package: current.goalDesignPackage,
          ...(current.goalRequirementDraft ? { goalRequirementDraft: current.goalRequirementDraft } : {}),
          ...(current.goalRequirementDraftHash ? { goalRequirementDraftHash: current.goalRequirementDraftHash } : {}),
        };
        setLiveDraft(next);
        if (next.goalDesignPhase) setLivePhase(next.goalDesignPhase);
        setLiveDraftState("ready");
      })
      .catch(() => {
        if (active) setLiveDraftState("error");
      });
    return () => { active = false; };
  }, [block.draftId, block.goalDesignPhase, stagedRevision]);

  if (!pkg || slices.length === 0) {
    return (
      <section data-testid="goal-slice-plan-block" style={cardStyle}>
        <Header
          title="Goal slice plan"
          subtitle={status ? `draft ${block.draftId} · ${status}` : `draft ${block.draftId}`}
          right={packageHash ? packageHash.slice(0, 12) : undefined}
        />
        <p style={bodyStyle}>No slice plan package was attached to this message.</p>
      </section>
    );
  }

  return (
    <section
      data-testid="goal-slice-plan-block"
      data-draft-id={block.draftId}
      style={cardStyle}
    >
      <Header
        title={pkg.goalContract?.summary ?? "Goal slice plan"}
        subtitle={[
          `draft ${block.draftId}`,
          status,
          packageHash ? packageHash.slice(0, 12) : undefined,
        ].filter(Boolean).join(" · ")}
        right={`rev ${pkg.revision ?? "?"}`}
      />
      <div style={metaRowStyle}>
        <span style={pillStyle}>strategy: {strategyMode}</span>
        <span style={pillStyle}>template: {templateMode}</span>
        {stagedRevision ? (
          <span data-testid="goal-slice-staged-revision" style={{ ...pillStyle, color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 42%, var(--border))" }}>
            Staged Slice revision · editable
          </span>
        ) : null}
      </div>
      {stagedRevision && liveDraftState === "loading" ? (
        <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 11 }}>Checking current staged revision before enabling actions…</div>
      ) : null}
      {stagedRevision && liveDraftState === "error" ? (
        <div style={{ marginTop: 8, color: "#f87171", fontSize: 11 }}>Unable to verify the current staged revision. Reload before continuing.</div>
      ) : null}
      {stagedRevision && liveRevisionReady && !frozen ? (
        <div style={{ marginTop: 8, padding: "7px 9px", borderRadius: 6, border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--border))", background: "color-mix(in srgb, var(--accent) 6%, var(--bg-panel))", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
          This staged revision keeps the confirmed Requirement / Contract lineage. Select S1–S4 to edit the Slice in the right-side editor, then choose <strong style={{ color: "var(--text)" }}>Save slice</strong>.
        </div>
      ) : null}
      <details data-testid="goal-slice-plan-guide" style={guideStyle}>
        <summary style={guideSummaryStyle}>How slices connect the goal to execution</summary>
        <div style={guideBodyStyle}>
          <div><strong>Requirement IDs:</strong> the user outcomes this slice must satisfy.</div>
          <div><strong>Outcome / mutation boundary / owner:</strong> what changes and which slice owns that change.</div>
          <div><strong>Expected artifact refs:</strong> the product proof produced by the slice. <strong>Evaluator refs:</strong> how that proof is checked.</div>
          <div><strong>Dependencies:</strong> the required slice order and upstream artifact handoff. Review these bindings before <em>Confirm &amp; Compose DAG</em>.</div>
        </div>
      </details>
      {pkg.compositionStrategy?.rationale ? (
        <p style={{ ...bodyStyle, marginTop: 8 }}>{pkg.compositionStrategy.rationale}</p>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        {slices.map((slice, index) => (
          <button
            key={slice.id}
            type="button"
            data-testid={`goal-slice-plan-item-${slice.id}`}
            onClick={() => onSliceSelect?.({
              draftId: block.draftId,
              status,
              goalDesignPackageHash: packageHash,
              selectedSliceId: slice.id,
              package: currentPackage,
              ...(phase ? { goalDesignPhase: phase } : {}),
              ...(requirementDraft ? { requirementDraft } : {}),
            })}
            style={sliceButtonStyle}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ color: "var(--text)", fontSize: 12 }}><span style={semanticRefStyle}>S{index + 1}</span> · {slice.outcome}</strong>
              <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                {slice.id} · {slice.requirementIds.length} req · {slice.expectedArtifactRefs.length} artifact
              </span>
            </div>
            <div style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45, textAlign: "left" }}>
              Covers requirement{slice.requirementIds.length === 1 ? "" : "s"}: {slice.requirementIds.join(", ") || "none"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
              {slice.dependsOnSliceIds.length > 0 ? <span style={miniPillStyle}>after {slice.dependsOnSliceIds.join(", ")}</span> : <span style={miniPillStyle}>no slice deps</span>}
              <span style={miniPillStyle}>{slice.stateOrArtifactOwner}</span>
              <span style={miniPillStyle}>{slice.evaluatorContractRefs.length} evaluator{slice.evaluatorContractRefs.length === 1 ? "" : "s"}</span>
            </div>
          </button>
        ))}
      </div>
      <CoverageGraphPreview
        testId="goal-slice-coverage-preview"
        persistLayoutKey={`goal-slice-coverage:${block.draftId}:${pkg.packageHash ?? packageHash ?? "unknown"}`}
        nodes={coverageGraph.nodes}
        edges={coverageGraph.edges}
        description="Slice coverage currently available from requirements, slice dependencies, artifact refs, and evaluator refs."
        onSelectNode={onLibraryGraphNodeSelect}
      />
      {frozen && liveRevisionReady && packageHash && onCreateGoalSliceRevision ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10, padding: 10, border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))", borderRadius: 7, background: "color-mix(in srgb, var(--accent) 6%, var(--bg-panel))" }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
            This Slice plan is read-only because the DAG is already validated. Create a new staged Slice revision to edit it without changing the existing DAG.
          </div>
          <button
            type="button"
            data-testid="goal-design-create-slice-revision"
            disabled={revisionState === "creating"}
            onClick={() => {
              setRevisionState("creating");
              setRevisionError(undefined);
              const selection: GoalSliceSelection = {
                draftId: block.draftId,
                status,
                goalDesignPackageHash: packageHash,
                selectedSliceId: slices[0]?.id,
                package: currentPackage,
                ...(phase ? { goalDesignPhase: phase } : {}),
                ...(requirementDraft ? { requirementDraft } : {}),
              };
              void Promise.resolve(onCreateGoalSliceRevision(selection)).catch((error) => {
                setRevisionState("error");
                setRevisionError(error instanceof Error ? error.message : String(error));
              }).then(() => {
                setRevisionState((current) => current === "creating" ? "idle" : current);
              });
            }}
            style={{ ...confirmButtonStyle, opacity: revisionState === "creating" ? 0.6 : 1 }}
          >
            {revisionState === "creating" ? "Creating Slice revision…" : "Create new Slice revision"}
          </button>
          {revisionError ? <div style={{ color: "#f87171", fontSize: 10, overflowWrap: "anywhere" }}>{revisionError}</div> : null}
        </div>
      ) : null}
      {!phaseKnown ? <div style={{ marginTop: 10, color: "var(--text-dim)", fontSize: 11 }}>Checking current Goal Design phase…</div> : null}
      {phaseKnown && liveRevisionReady && !frozen && status === "ready_for_review" && packageHash && onConfirmGoalDesign ? (
        <button
          type="button"
          data-testid="goal-design-confirm-compose"
          onClick={() => onConfirmGoalDesign({
            draftId: block.draftId,
            status,
            goalDesignPackageHash: packageHash,
            package: currentPackage,
            selectedSliceId: slices[0]?.id,
            ...(phase ? { goalDesignPhase: phase } : {}),
            ...(requirementDraft ? { requirementDraft } : {}),
          })}
          style={confirmButtonStyle}
        >
          Confirm &amp; Compose DAG
        </button>
      ) : null}
    </section>
  );
}

function Header({ title, subtitle, right }: { title: string; subtitle?: string; right?: string }) {
  return (
    <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
      <div style={{ minWidth: 0 }}>
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 13, fontWeight: 700, lineHeight: 1.35 }}>{title}</h3>
        {subtitle ? <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{subtitle}</div> : null}
      </div>
      {right ? <span style={{ ...pillStyle, flexShrink: 0 }}>{right}</span> : null}
    </header>
  );
}

function goalDesignPackageView(value: unknown): GoalDesignPackageView | null {
  if (!isRecord(value)) return null;
  const slicePlan = isRecord(value.slicePlan) ? value.slicePlan : undefined;
  const slices = Array.isArray(slicePlan?.slices)
    ? slicePlan.slices.map(goalSliceView).filter((slice): slice is GoalSliceView => Boolean(slice))
    : [];
  return {
    revision: typeof value.revision === "number" ? value.revision : undefined,
    packageHash: typeof value.packageHash === "string" ? value.packageHash : undefined,
    goalContract: isRecord(value.goalContract) ? { summary: typeof value.goalContract.summary === "string" ? value.goalContract.summary : undefined } : undefined,
    validationBindings: Array.isArray(value.validationBindings)
      ? value.validationBindings.map(validationBindingView).filter((binding): binding is ValidationBindingView => Boolean(binding))
      : [],
    slicePlan: { slices },
    compositionStrategy: isRecord(value.compositionStrategy)
      ? {
          mode: typeof value.compositionStrategy.mode === "string" ? value.compositionStrategy.mode : undefined,
          rationale: typeof value.compositionStrategy.rationale === "string" ? value.compositionStrategy.rationale : undefined,
        }
      : undefined,
    templatePolicy: isRecord(value.templatePolicy)
      ? {
          mode: typeof value.templatePolicy.mode === "string" ? value.templatePolicy.mode : undefined,
          templateRef: typeof value.templatePolicy.templateRef === "string" ? value.templatePolicy.templateRef : undefined,
          versionRef: typeof value.templatePolicy.versionRef === "string" ? value.templatePolicy.versionRef : undefined,
        }
      : undefined,
  };
}

function validationBindingView(value: unknown): ValidationBindingView | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.requirementId !== "string" || !Array.isArray(value.criterionBindings)) return null;
  const criterionBindings = value.criterionBindings
    .filter(isRecord)
    .filter((criterionBinding) => (
      typeof criterionBinding.artifactContractRef === "string"
      && typeof criterionBinding.evaluatorProfileRef === "string"
    ))
    .map((criterionBinding) => ({
      artifactContractRef: criterionBinding.artifactContractRef as string,
      evaluatorProfileRef: criterionBinding.evaluatorProfileRef as string,
    }));
  return { id: value.id, requirementId: value.requirementId, criterionBindings };
}

function goalSliceView(value: unknown): GoalSliceView | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.outcome !== "string") return null;
  return {
    id: value.id,
    requirementIds: stringArray(value.requirementIds),
    outcome: value.outcome,
    stateOrArtifactOwner: typeof value.stateOrArtifactOwner === "string" ? value.stateOrArtifactOwner : "owner:auto",
    mutationBoundary: typeof value.mutationBoundary === "string" ? value.mutationBoundary : "",
    expectedArtifactRefs: stringArray(value.expectedArtifactRefs),
    evaluatorContractRefs: stringArray(value.evaluatorContractRefs),
    dependsOnSliceIds: stringArray(value.dependsOnSliceIds),
    dependencyArtifactRefs: stringArray(value.dependencyArtifactRefs),
    mergeReason: typeof value.mergeReason === "string" ? value.mergeReason : undefined,
  };
}

function buildSliceCoverageGraph(
  slices: GoalSliceView[],
  requirementContent: GoalRequirementsContent | null,
  pkg: GoalDesignPackageView | null,
): CoverageGraphData {
  const nodes = new Map<string, LibraryGraphChartNode>();
  const edges: LibraryGraphChartEdge[] = [];
  const edgeKeys = new Set<string>();
  const requirements = new Map((requirementContent?.draft.requirements ?? []).map((requirement) => [requirement.id, requirement]));
  const slicesById = new Map(slices.map((slice) => [slice.id, slice]));
  const addNode = (node: LibraryGraphChartNode) => {
    if (!nodes.has(node.objectKey)) nodes.set(node.objectKey, node);
  };
  const addEdge = (fromObjectKey: string, toObjectKey: string, edgeType: string) => {
    const key = `${fromObjectKey}:${edgeType}:${toObjectKey}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromObjectKey, toObjectKey, edgeType });
  };
  const addRequirement = (requirementId: string) => {
    const requirement = requirements.get(requirementId);
    addNode({
      objectKey: `requirement:${requirementId}`,
      objectKind: "requirement",
      status: requirement?.status ?? "proposed",
      title: `Requirement ${requirementId}`,
      ...(requirement ? { metadata: { title: requirement.title, statement: requirement.statement } } : {}),
    });
  };

  for (const slice of slices) {
    const sliceKey = `slice:${slice.id}`;
    addNode({ objectKey: sliceKey, objectKind: "slice", status: "proposed", title: `Slice ${slice.id}`, metadata: { outcome: slice.outcome } });
    for (const requirementId of slice.requirementIds) {
      addRequirement(requirementId);
      addEdge(`requirement:${requirementId}`, sliceKey, "covered by slice");
    }
    for (const ref of slice.expectedArtifactRefs) {
      addNode({ objectKey: ref, objectKind: "artifact", status: "proposed", title: `Artifact ${ref}` });
      addEdge(sliceKey, ref, "expects artifact");
    }
    for (const ref of slice.evaluatorContractRefs) {
      const binding = pkg?.validationBindings.find((candidate) => candidate.id === ref);
      const evaluatorRefs = binding
        ? [...new Set(binding.criterionBindings.map((criterionBinding) => criterionBinding.evaluatorProfileRef))]
        : [ref];
      for (const evaluatorRef of evaluatorRefs) {
        addNode({
          objectKey: evaluatorRef,
          objectKind: "evaluator",
          status: "proposed",
          title: `Evaluator ${evaluatorRef}`,
          ...(binding ? { metadata: { validationBindingId: binding.id, requirementId: binding.requirementId } } : {}),
        });
        addEdge(sliceKey, evaluatorRef, "checked by evaluator");
      }
    }
    for (const dependencyId of slice.dependsOnSliceIds) {
      const dependency = slicesById.get(dependencyId);
      addNode({
        objectKey: `slice:${dependencyId}`,
        objectKind: "slice",
        status: dependency ? "proposed" : "blocked",
        title: `Slice ${dependencyId}`,
        ...(dependency ? { metadata: { outcome: dependency.outcome } } : {}),
      });
      addEdge(`slice:${dependencyId}`, sliceKey, "depends on");
    }
  }

  return { nodes: [...nodes.values()], edges };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const cardStyle = {
  border: "1px solid rgba(34,197,94,0.22)",
  borderRadius: 8,
  background: "rgba(34,197,94,0.045)",
  padding: 12,
  marginTop: 10,
} as const;

const metaRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 9,
} as const;

const pillStyle = {
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "2px 7px",
  color: "var(--text-dim)",
  background: "var(--bg)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
} as const;

const semanticRefStyle = { color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 10 } as const;

const guideStyle = {
  marginTop: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.45,
} as const;

const guideSummaryStyle = { cursor: "pointer", padding: "7px 9px", color: "var(--text)" } as const;
const guideBodyStyle = { display: "grid", gap: 5, padding: "0 9px 9px" } as const;

const miniPillStyle = {
  ...pillStyle,
  borderRadius: 5,
  background: "rgba(0,0,0,0.08)",
} as const;

const bodyStyle = {
  margin: 0,
  color: "var(--text-muted)",
  fontSize: 12,
  lineHeight: 1.5,
} as const;

const sliceButtonStyle = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg-panel)",
  padding: 10,
  cursor: "pointer",
} as const;

const confirmButtonStyle = {
  marginTop: 10,
  width: "100%",
  border: "1px solid var(--accent)",
  borderRadius: 7,
  background: "var(--accent)",
  color: "#fff",
  padding: "8px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
} as const;
