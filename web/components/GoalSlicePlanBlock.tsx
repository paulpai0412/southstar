"use client";

import type { GoalDesignContent, GoalSliceSelection } from "@/lib/types";

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

type GoalDesignPackageView = {
  revision?: number;
  packageHash?: string;
  goalContract?: { summary?: string };
  slicePlan?: { slices?: GoalSliceView[] };
  compositionStrategy?: { mode?: string; rationale?: string };
  templatePolicy?: { mode?: string; templateRef?: string; versionRef?: string };
};

export function GoalSlicePlanBlock({
  block,
  onSliceSelect,
  onConfirmGoalDesign,
}: {
  block: GoalDesignContent;
  onSliceSelect?: (selection: GoalSliceSelection) => void;
  onConfirmGoalDesign?: (selection: GoalSliceSelection) => void;
}) {
  const pkg = goalDesignPackageView(block.package);
  const slices = pkg?.slicePlan?.slices ?? [];
  const packageHash = block.goalDesignPackageHash ?? pkg?.packageHash;
  const strategyMode = pkg?.compositionStrategy?.mode ?? "unknown";
  const templateMode = pkg?.templatePolicy?.mode ?? "auto";

  if (!pkg || slices.length === 0) {
    return (
      <section data-testid="goal-slice-plan-block" style={cardStyle}>
        <Header
          title="Goal slice plan"
          subtitle={block.status ? `draft ${block.draftId} · ${block.status}` : `draft ${block.draftId}`}
          right={packageHash ? packageHash.slice(0, 12) : undefined}
        />
        <p style={bodyStyle}>No slice plan package was attached to this message.</p>
      </section>
    );
  }

  return (
    <section data-testid="goal-slice-plan-block" style={cardStyle}>
      <Header
        title={pkg.goalContract?.summary ?? "Goal slice plan"}
        subtitle={[
          `draft ${block.draftId}`,
          block.status,
          packageHash ? packageHash.slice(0, 12) : undefined,
        ].filter(Boolean).join(" · ")}
        right={`rev ${pkg.revision ?? "?"}`}
      />
      <div style={metaRowStyle}>
        <span style={pillStyle}>strategy: {strategyMode}</span>
        <span style={pillStyle}>template: {templateMode}</span>
      </div>
      {pkg.compositionStrategy?.rationale ? (
        <p style={{ ...bodyStyle, marginTop: 8 }}>{pkg.compositionStrategy.rationale}</p>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        {slices.map((slice) => (
          <button
            key={slice.id}
            type="button"
            data-testid={`goal-slice-plan-item-${slice.id}`}
            onClick={() => onSliceSelect?.({
              draftId: block.draftId,
              status: block.status,
              goalDesignPackageHash: packageHash,
              selectedSliceId: slice.id,
              package: block.package,
            })}
            style={sliceButtonStyle}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ color: "var(--text)", fontSize: 12 }}>{slice.id}</strong>
              <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                {slice.requirementIds.length} req · {slice.expectedArtifactRefs.length} artifact
              </span>
            </div>
            <div style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45, textAlign: "left" }}>
              {slice.outcome}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
              {slice.dependsOnSliceIds.length > 0 ? <span style={miniPillStyle}>after {slice.dependsOnSliceIds.join(", ")}</span> : <span style={miniPillStyle}>no slice deps</span>}
              <span style={miniPillStyle}>{slice.stateOrArtifactOwner}</span>
            </div>
          </button>
        ))}
      </div>
      {block.status === "ready_for_review" && packageHash && onConfirmGoalDesign ? (
        <button
          type="button"
          data-testid="goal-design-confirm-compose"
          onClick={() => onConfirmGoalDesign({
            draftId: block.draftId,
            status: block.status,
            goalDesignPackageHash: packageHash,
            package: block.package,
            selectedSliceId: slices[0]?.id,
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
