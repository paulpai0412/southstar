"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { GoalSliceSelection } from "@/lib/types";

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
};

type SliceForm = {
  outcome: string;
  requirementIds: string;
  stateOrArtifactOwner: string;
  mutationBoundary: string;
  expectedArtifactRefs: string;
  evaluatorContractRefs: string;
  dependsOnSliceIds: string;
  dependencyArtifactRefs: string;
  mergeReason: string;
};

export function GoalSliceEditor({
  selection,
  onPackageChange,
}: {
  selection: GoalSliceSelection;
  onPackageChange?: (selection: GoalSliceSelection) => void;
}) {
  const pkg = useMemo(() => goalDesignPackageView(selection.package), [selection.package]);
  const slice = useMemo(
    () => pkg?.slicePlan?.slices?.find((candidate) => candidate.id === selection.selectedSliceId) ?? null,
    [pkg, selection.selectedSliceId],
  );
  const sliceIndex = useMemo(
    () => pkg?.slicePlan?.slices?.findIndex((candidate) => candidate.id === selection.selectedSliceId) ?? -1,
    [pkg, selection.selectedSliceId],
  );
  const [form, setForm] = useState<SliceForm>(() => slice ? formFromSlice(slice) : emptyForm());
  const [state, setState] = useState<{ status: "idle" | "saving" | "saved" | "error"; message?: string }>({ status: "idle" });

  useEffect(() => {
    setForm(slice ? formFromSlice(slice) : emptyForm());
    setState({ status: "idle" });
  }, [slice, selection.selectedSliceId, selection.goalDesignPackageHash]);

  if (!pkg || !slice) {
    return (
      <div data-testid="goal-slice-editor" style={shellStyle}>
        <Header title="Goal Slice" subtitle={selection.selectedSliceId} />
        <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>
          This slice is no longer available in the attached Goal Design package.
        </div>
      </div>
    );
  }

  const packageHash = selection.goalDesignPackageHash ?? pkg.packageHash;
  const canSave = Boolean(packageHash) && state.status !== "saving";

  const save = async () => {
    if (!packageHash) {
      setState({ status: "error", message: "Goal Design package hash is missing." });
      return;
    }
    setState({ status: "saving" });
    try {
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(selection.draftId)}/goal-design/slices/${encodeURIComponent(selection.selectedSliceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPackageHash: packageHash,
          patch: patchFromForm(form),
        }),
      });
      const payload = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) throw new Error(errorMessage(payload) ?? `HTTP ${response.status}`);
      const nextPackage = envelopeResult(payload) ?? payload;
      const nextHash = goalDesignPackageView(nextPackage)?.packageHash;
      if (!nextHash) throw new Error("Goal Design save response did not include a packageHash.");
      const nextSelection: GoalSliceSelection = {
        ...selection,
        package: nextPackage,
        goalDesignPackageHash: nextHash,
      };
      onPackageChange?.(nextSelection);
      setState({ status: "saved", message: `Saved revision ${goalDesignPackageView(nextPackage)?.revision ?? "?"}` });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div data-testid="goal-slice-editor" style={shellStyle}>
      <Header
        title={`${sliceIndex >= 0 ? `S${sliceIndex + 1} · ` : ""}${slice.outcome}`}
        subtitle={[
          slice.id,
          `covers ${slice.requirementIds.join(", ") || "no requirements"}`,
          pkg.goalContract?.summary,
          pkg.compositionStrategy?.mode ? `strategy ${pkg.compositionStrategy.mode}` : undefined,
          packageHash ? packageHash.slice(0, 12) : undefined,
        ].filter(Boolean).join(" · ")}
      />
      <details data-testid="goal-slice-editor-guide" style={guideStyle}>
        <summary style={guideSummaryStyle}>How to edit a slice safely</summary>
        <div style={guideBodyStyle}>
          <div><strong>Requirement IDs</strong> bind this slice to user outcomes; keep them aligned with the requirement list.</div>
          <div><strong>Expected artifact refs</strong> describe the product proof; <strong>evaluator contract refs</strong> describe how the proof is judged.</div>
          <div><strong>Depends on</strong> fields describe ordering and artifact handoff. Save, then recheck the package before composing the DAG.</div>
        </div>
      </details>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Outcome" help="What becomes true for the user after this slice completes.">
          <textarea value={form.outcome} onChange={(event) => setForm((current) => ({ ...current, outcome: event.target.value }))} rows={4} style={textareaStyle} />
        </Field>
        <Field label="State / artifact owner" help="The state or product artifact this slice is responsible for changing.">
          <input value={form.stateOrArtifactOwner} onChange={(event) => setForm((current) => ({ ...current, stateOrArtifactOwner: event.target.value }))} style={inputStyle} />
        </Field>
        <Field label="Mutation boundary" help="The allowed change boundary; keep unrelated work out of this slice.">
          <textarea value={form.mutationBoundary} onChange={(event) => setForm((current) => ({ ...current, mutationBoundary: event.target.value }))} rows={3} style={textareaStyle} />
        </Field>
        <Field label="Requirement IDs" help="The requirement IDs this slice covers, one per line.">
          <TextareaList value={form.requirementIds} onChange={(value) => setForm((current) => ({ ...current, requirementIds: value }))} />
        </Field>
        <Field label="Expected artifact refs" help="Product evidence this slice must produce, not a generic status report.">
          <TextareaList value={form.expectedArtifactRefs} onChange={(value) => setForm((current) => ({ ...current, expectedArtifactRefs: value }))} />
        </Field>
        <Field label="Evaluator contract refs" help="Evaluator definitions that decide whether the slice evidence passes.">
          <TextareaList value={form.evaluatorContractRefs} onChange={(value) => setForm((current) => ({ ...current, evaluatorContractRefs: value }))} />
        </Field>
        <Field label="Depends on slice IDs" help="Slices that must complete first.">
          <TextareaList value={form.dependsOnSliceIds} onChange={(value) => setForm((current) => ({ ...current, dependsOnSliceIds: value }))} />
        </Field>
        <Field label="Dependency artifact refs" help="Upstream artifacts this slice consumes.">
          <TextareaList value={form.dependencyArtifactRefs} onChange={(value) => setForm((current) => ({ ...current, dependencyArtifactRefs: value }))} />
        </Field>
        <Field label="Merge reason" help="Why this slice is merged with or kept separate from adjacent work.">
          <textarea value={form.mergeReason} onChange={(event) => setForm((current) => ({ ...current, mergeReason: event.target.value }))} rows={2} style={textareaStyle} />
        </Field>
      </div>
      <footer style={footerStyle}>
        <div style={{ minWidth: 0, color: state.status === "error" ? "#f87171" : "var(--text-dim)", fontSize: 11, overflowWrap: "anywhere" }}>
          {state.message ?? (packageHash ? `expected package ${packageHash.slice(0, 12)}` : "missing package hash")}
        </div>
        <button type="button" disabled={!canSave} onClick={save} style={{ ...buttonStyle, opacity: canSave ? 1 : 0.55 }}>
          {state.status === "saving" ? "Saving…" : "Save slice"}
        </button>
      </footer>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 2, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</div> : null}
      </div>
    </header>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ color: "var(--text-dim)", fontSize: 11, fontWeight: 650 }}>{label}</span>
      {help ? <span style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.35 }}>{help}</span> : null}
      {children}
    </label>
  );
}

function TextareaList({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} style={textareaStyle} placeholder="One item per line, or comma-separated" />;
}

function formFromSlice(slice: GoalSliceView): SliceForm {
  return {
    outcome: slice.outcome,
    requirementIds: slice.requirementIds.join("\n"),
    stateOrArtifactOwner: slice.stateOrArtifactOwner,
    mutationBoundary: slice.mutationBoundary,
    expectedArtifactRefs: slice.expectedArtifactRefs.join("\n"),
    evaluatorContractRefs: slice.evaluatorContractRefs.join("\n"),
    dependsOnSliceIds: slice.dependsOnSliceIds.join("\n"),
    dependencyArtifactRefs: slice.dependencyArtifactRefs.join("\n"),
    mergeReason: slice.mergeReason ?? "",
  };
}

function emptyForm(): SliceForm {
  return {
    outcome: "",
    requirementIds: "",
    stateOrArtifactOwner: "",
    mutationBoundary: "",
    expectedArtifactRefs: "",
    evaluatorContractRefs: "",
    dependsOnSliceIds: "",
    dependencyArtifactRefs: "",
    mergeReason: "",
  };
}

function patchFromForm(form: SliceForm): Record<string, unknown> {
  return {
    outcome: form.outcome.trim(),
    requirementIds: lines(form.requirementIds),
    stateOrArtifactOwner: form.stateOrArtifactOwner.trim(),
    mutationBoundary: form.mutationBoundary.trim(),
    expectedArtifactRefs: lines(form.expectedArtifactRefs),
    evaluatorContractRefs: lines(form.evaluatorContractRefs),
    dependsOnSliceIds: lines(form.dependsOnSliceIds),
    dependencyArtifactRefs: lines(form.dependencyArtifactRefs),
    ...(form.mergeReason.trim() ? { mergeReason: form.mergeReason.trim() } : {}),
  };
}

function lines(value: string): string[] {
  return value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  };
}

function goalSliceView(value: unknown): GoalSliceView | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.outcome !== "string") return null;
  return {
    id: value.id,
    requirementIds: stringArray(value.requirementIds),
    outcome: value.outcome,
    stateOrArtifactOwner: typeof value.stateOrArtifactOwner === "string" ? value.stateOrArtifactOwner : "",
    mutationBoundary: typeof value.mutationBoundary === "string" ? value.mutationBoundary : "",
    expectedArtifactRefs: stringArray(value.expectedArtifactRefs),
    evaluatorContractRefs: stringArray(value.evaluatorContractRefs),
    dependsOnSliceIds: stringArray(value.dependsOnSliceIds),
    dependencyArtifactRefs: stringArray(value.dependencyArtifactRefs),
    mergeReason: typeof value.mergeReason === "string" ? value.mergeReason : undefined,
  };
}

function envelopeResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : undefined;
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const shellStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
} as const;

const inputStyle = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "7px 8px",
  fontSize: 12,
} as const;

const textareaStyle = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 54,
  lineHeight: 1.45,
} as const;

const guideStyle = {
  margin: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.45,
} as const;

const guideSummaryStyle = { cursor: "pointer", padding: "7px 9px", color: "var(--text)" } as const;
const guideBodyStyle = { display: "grid", gap: 5, padding: "0 9px 9px" } as const;

const footerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: 10,
  borderTop: "1px solid var(--border)",
  background: "var(--bg-panel)",
} as const;

const buttonStyle = {
  border: "1px solid rgba(34,197,94,0.35)",
  borderRadius: 6,
  background: "rgba(34,197,94,0.14)",
  color: "var(--text)",
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 650,
  whiteSpace: "nowrap",
} as const;
