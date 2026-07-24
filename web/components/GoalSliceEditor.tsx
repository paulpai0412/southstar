"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { readLibraryObjectDetail } from "@/lib/library/api";
import type { LibraryObjectDetail } from "@/lib/library/types";
import type { GoalDesignPhase, GoalSliceSelection } from "@/lib/types";
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

type ExpectedArtifactView = {
  description: string;
  mediaType?: string;
  path?: string;
};

type GoalContractRequirementView = {
  id: string;
  expectedArtifacts: ExpectedArtifactView[];
};

type CriterionBindingView = {
  criterionContract?: {
    id: string;
    version: number;
    observableClaim: string;
    blocking: boolean;
    verificationIntent: string[];
    requiredAssurance: string[];
  };
  artifactContractRef: string;
  artifactContractVersionRef: string;
  evaluatorProfileRef: string;
  evaluatorProfileVersionRef: string;
  verificationMode: string;
  procedureRef: string;
  expectedEvidenceKinds: string[];
  independence: string;
  failureClassifications: string[];
};

type ValidationBindingView = {
  id: string;
  requirementId: string;
  criterionBindings: CriterionBindingView[];
};

type GoalDesignPackageView = {
  revision?: number;
  packageHash?: string;
  goalContract?: { summary?: string; requirements: GoalContractRequirementView[] };
  validationBindings: ValidationBindingView[];
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
  const [livePhase, setLivePhase] = useState<GoalDesignPhase | undefined>(selection.goalDesignPhase);
  const [libraryDetails, setLibraryDetails] = useState<Record<string, LibraryObjectDetail>>({});
  const libraryRefs = useMemo(() => libraryRefsForSlice(slice, pkg), [pkg, slice]);

  useEffect(() => {
    let active = true;
    setLibraryDetails({});
    if (libraryRefs.length === 0) return () => { active = false; };
    void Promise.all(libraryRefs.map(async (ref) => {
      try {
        return [ref, await readLibraryObjectDetail(ref)] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!active) return;
      setLibraryDetails(Object.fromEntries(entries.filter((entry): entry is readonly [string, LibraryObjectDetail] => Boolean(entry))));
    });
    return () => { active = false; };
  }, [libraryRefs]);

  useEffect(() => {
    setForm(slice ? formFromSlice(slice) : emptyForm());
    setState({ status: "idle" });
  }, [slice, selection.selectedSliceId, selection.goalDesignPackageHash]);

  useEffect(() => {
    if (selection.goalDesignPhase) return;
    let active = true;
    void fetch(`/api/workflow/planner-drafts/${encodeURIComponent(selection.draftId)}/orchestration`)
      .then((response) => response.ok ? response.json() as Promise<unknown> : undefined)
      .then((payload) => {
        if (!active || !payload || typeof payload !== "object") return;
        const result = (payload as { result?: unknown }).result;
        const value = result && typeof result === "object" ? (result as { goalDesignPhase?: unknown }).goalDesignPhase : undefined;
        if (typeof value === "string") setLivePhase(value as GoalDesignPhase);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [selection.draftId, selection.goalDesignPhase]);

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
  const phase = livePhase ?? selection.goalDesignPhase;
  const frozen = phase === "composing" || phase === "dag_validated";
  const canSave = Boolean(phase) && !frozen && Boolean(packageHash) && state.status !== "saving";

  const save = async () => {
    if (!packageHash) {
      setState({ status: "error", message: "Goal Design package hash is missing." });
      return;
    }
    setState({ status: "saving" });
    try {
      const current = await readCurrentGoalDesignDraft(selection.draftId);
      if (!current.goalDesignPhase) throw new Error("Current Goal Design phase is unavailable.");
      if (current.goalDesignPhase === "composing" || current.goalDesignPhase === "dag_validated") {
        throw new Error("goal_design_frozen: the current Goal Design is no longer editable");
      }
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(selection.draftId)}/goal-design/slices/${encodeURIComponent(selection.selectedSliceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPackageHash: current.goalDesignPackageHash,
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
        goalDesignPhase: current.goalDesignPhase,
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
          <textarea disabled={frozen} value={form.outcome} onChange={(event) => setForm((current) => ({ ...current, outcome: event.target.value }))} rows={4} style={textareaStyle} />
        </Field>
        <Field label="State / artifact owner" help="The state or product artifact this slice is responsible for changing.">
          <input disabled={frozen} value={form.stateOrArtifactOwner} onChange={(event) => setForm((current) => ({ ...current, stateOrArtifactOwner: event.target.value }))} style={inputStyle} />
        </Field>
        <Field label="Mutation boundary" help="The allowed change boundary; keep unrelated work out of this slice.">
          <textarea disabled={frozen} value={form.mutationBoundary} onChange={(event) => setForm((current) => ({ ...current, mutationBoundary: event.target.value }))} rows={3} style={textareaStyle} />
        </Field>
        <Field label="Requirement IDs" help="The requirement IDs this slice covers, one per line.">
          <TextareaList disabled={frozen} value={form.requirementIds} onChange={(value) => setForm((current) => ({ ...current, requirementIds: value }))} />
          <ReferenceList
            testId="goal-slice-reference-list-requirements"
            items={slice.requirementIds}
            describe={(id) => requirementDescription(id, selection.requirementDraft)}
          />
        </Field>
        <Field label="Expected artifact refs" help="Product evidence this slice must produce, not a generic status report.">
          <TextareaList disabled={frozen} value={form.expectedArtifactRefs} onChange={(value) => setForm((current) => ({ ...current, expectedArtifactRefs: value }))} />
          <ReferenceList
            testId="goal-slice-reference-list-artifacts"
            items={slice.expectedArtifactRefs}
            describe={(id) => expectedArtifactDescription(id, slice, pkg, selection, libraryDetails)}
          />
        </Field>
        <Field label="Evaluator contract refs" help="Evaluator definitions that decide whether the slice evidence passes.">
          <TextareaList disabled={frozen} value={form.evaluatorContractRefs} onChange={(value) => setForm((current) => ({ ...current, evaluatorContractRefs: value }))} />
          <ReferenceList
            testId="goal-slice-reference-list-evaluators"
            items={slice.evaluatorContractRefs}
            describe={(id) => evaluatorDescription(id, slice, pkg, libraryDetails)}
          />
        </Field>
        <Field label="Depends on slice IDs" help="Slices that must complete first.">
          <TextareaList disabled={frozen} value={form.dependsOnSliceIds} onChange={(value) => setForm((current) => ({ ...current, dependsOnSliceIds: value }))} />
          <ReferenceList
            testId="goal-slice-reference-list-depends"
            items={slice.dependsOnSliceIds}
            describe={(id) => {
              const dependency = pkg.slicePlan?.slices?.find((candidate) => candidate.id === id);
              return dependency ? `Slice outcome: ${dependency.outcome}` : "Referenced slice is not in this package";
            }}
          />
        </Field>
        <Field label="Dependency artifact refs" help="Upstream artifacts this slice consumes.">
          <TextareaList disabled={frozen} value={form.dependencyArtifactRefs} onChange={(value) => setForm((current) => ({ ...current, dependencyArtifactRefs: value }))} />
          <ReferenceList
            testId="goal-slice-reference-list-dependencies"
            items={slice.dependencyArtifactRefs}
            describe={(id) => expectedArtifactDescription(id, slice, pkg, selection, libraryDetails)}
          />
        </Field>
        <Field label="Merge reason" help="Why this slice is merged with or kept separate from adjacent work.">
          <textarea disabled={frozen} value={form.mergeReason} onChange={(event) => setForm((current) => ({ ...current, mergeReason: event.target.value }))} rows={2} style={textareaStyle} />
        </Field>
      </div>
      <footer style={footerStyle}>
        <div style={{ minWidth: 0, color: state.status === "error" ? "#f87171" : "var(--text-dim)", fontSize: 11, overflowWrap: "anywhere" }}>
          {state.message ?? (!phase
            ? "Checking current Goal Design phase…"
            : frozen
              ? "DAG validated; this Slice is read-only. Create a new Slice revision from the Goal Slice Plan."
              : packageHash ? `expected package ${packageHash.slice(0, 12)}` : "missing package hash")}
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

function TextareaList({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <textarea disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} rows={3} style={textareaStyle} placeholder="One item per line, or comma-separated" />;
}

function ReferenceList({ testId, items, describe }: { testId: string; items: string[]; describe: (id: string) => string }) {
  if (items.length === 0) return null;
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "5px 7px", borderLeft: "2px solid var(--accent)", color: "var(--text-muted)", fontSize: 10, lineHeight: 1.4 }}>
      {items.map((id) => (
        <div key={id}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>{id}</span>
          <span> — {describe(id)}</span>
        </div>
      ))}
    </div>
  );
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

function requirementDescription(id: string, draft?: GoalSliceSelection["requirementDraft"]): string {
  const requirement = draft?.requirements.find((candidate) => candidate.id === id);
  return requirement
    ? `${requirement.title} — ${requirement.statement}`
    : "Requirement content is not attached to this Goal Design package";
}

function expectedArtifactDescription(
  ref: string,
  slice: GoalSliceView,
  pkg: GoalDesignPackageView,
  selection: GoalSliceSelection,
  libraryDetails: Record<string, LibraryObjectDetail>,
): string {
  const libraryDetail = libraryDetails[ref];
  if (libraryDetail) return libraryObjectDescription(libraryDetail, "artifact");
  const binding = pkg.validationBindings.find((candidate) => (
    slice.requirementIds.includes(candidate.requirementId)
      && candidate.criterionBindings.some((criterionBinding) => criterionBinding.artifactContractRef === ref)
  ));
  const criterionBinding = binding?.criterionBindings.find((candidate) => candidate.artifactContractRef === ref);
  const contractRequirement = binding
    ? pkg.goalContract?.requirements.find((requirement) => requirement.id === binding.requirementId)
    : undefined;
  const draftRequirement = binding
    ? selection.requirementDraft?.requirements.find((requirement) => requirement.id === binding.requirementId)
    : undefined;
  const generatedArtifact = generatedArtifactView(ref, pkg, selection);
  const artifact = generatedArtifact
    ?? contractRequirement?.expectedArtifacts[0]
    ?? expectedArtifactFromDraft(draftRequirement?.expectedOutcomeArtifacts[0]);
  if (!artifact) return "Artifact contract content is not attached to this package";
  return [
    artifact.description,
    artifact.mediaType ? `media type: ${artifact.mediaType}` : undefined,
    artifact.path ? `path: ${artifact.path}` : undefined,
    criterionBinding?.artifactContractVersionRef ? `version: ${criterionBinding.artifactContractVersionRef}` : undefined,
    criterionBinding?.criterionContract?.observableClaim ? `criterion: ${criterionBinding.criterionContract.observableClaim}` : undefined,
  ].filter(Boolean).join(" · ");
}

function evaluatorDescription(ref: string, slice: GoalSliceView, pkg: GoalDesignPackageView, libraryDetails: Record<string, LibraryObjectDetail>): string {
  const binding = pkg.validationBindings.find((candidate) => (
    slice.requirementIds.includes(candidate.requirementId)
      && (candidate.id === ref || candidate.criterionBindings.some((criterionBinding) => criterionBinding.evaluatorProfileRef === ref))
  ));
  if (binding) {
    const criterionBindings = binding.criterionBindings.filter((criterionBinding) => (
      candidateRefMatches(criterionBinding.evaluatorProfileRef, ref, binding.id)
    ));
    const profiles = [...new Map(criterionBindings.map((criterionBinding) => [
      criterionBinding.evaluatorProfileRef,
      criterionBinding,
    ])).values()];
    return [
      profiles.length > 0
        ? profiles.map((criterionBinding) => {
            const profileDetail = libraryDetails[criterionBinding.evaluatorProfileRef];
            return profileDetail
              ? libraryObjectDescription(profileDetail, "evaluator")
              : `profile: ${criterionBinding.evaluatorProfileRef}`;
          }).join(" / ")
        : "Evaluator profile is not attached to this binding",
      profiles.length > 0
        ? `version: ${[...new Set(profiles.map((criterionBinding) => criterionBinding.evaluatorProfileVersionRef))].join(", ")}`
        : undefined,
      criterionBindings.length > 0
        ? `mode: ${[...new Set(criterionBindings.map((criterionBinding) => criterionBinding.verificationMode))].join(", ")}`
        : undefined,
      criterionBindings.length > 0
        ? `evidence: ${[...new Set(criterionBindings.flatMap((criterionBinding) => criterionBinding.expectedEvidenceKinds))].join(", ")}`
        : undefined,
      criterionBindings.length > 0
        ? `criteria: ${criterionBindings.map((criterionBinding) => criterionBinding.criterionContract?.observableClaim ?? criterionBinding.procedureRef).join(" / ")}`
        : undefined,
    ].filter(Boolean).join(" · ");
  }
  return "Evaluator contract content is not attached to this package";
}

function candidateRefMatches(profileRef: string, requestedRef: string, bindingId: string): boolean {
  return requestedRef === bindingId || requestedRef === profileRef;
}

function libraryRefsForSlice(slice: GoalSliceView | null, pkg: GoalDesignPackageView | null): string[] {
  if (!slice || !pkg) return [];
  const profileRefs = pkg.validationBindings
    .filter((binding) => slice.requirementIds.includes(binding.requirementId))
    .flatMap((binding) => binding.criterionBindings.map((criterionBinding) => criterionBinding.evaluatorProfileRef));
  const artifactRefs = pkg.validationBindings
    .filter((binding) => slice.requirementIds.includes(binding.requirementId))
    .flatMap((binding) => binding.criterionBindings.map((criterionBinding) => criterionBinding.artifactContractRef));
  return [...new Set([
    ...slice.expectedArtifactRefs.filter((ref) => !ref.startsWith("artifact.goal.")),
    ...slice.dependencyArtifactRefs.filter((ref) => !ref.startsWith("artifact.goal.")),
    ...artifactRefs,
    ...profileRefs,
  ])];
}

function generatedArtifactView(ref: string, pkg: GoalDesignPackageView, selection: GoalSliceSelection): ExpectedArtifactView | undefined {
  const match = /^artifact\.goal\.(.+)\.(\d+)$/.exec(ref);
  if (!match) return undefined;
  const index = Number(match[2]) - 1;
  if (!Number.isInteger(index) || index < 0) return undefined;
  const requirementId = match[1]!;
  const contractRequirement = pkg.goalContract?.requirements.find((requirement) => requirement.id === requirementId);
  const draftRequirement = selection.requirementDraft?.requirements.find((requirement) => requirement.id === requirementId);
  return contractRequirement?.expectedArtifacts[index] ?? expectedArtifactFromDraft(draftRequirement?.expectedOutcomeArtifacts[index]);
}

function expectedArtifactFromDraft(value: { description: string; mediaType?: string } | undefined): ExpectedArtifactView | undefined {
  return value ? { description: value.description, ...(value.mediaType ? { mediaType: value.mediaType } : {}) } : undefined;
}

function libraryObjectDescription(detail: LibraryObjectDetail, kind: "artifact" | "evaluator"): string {
  const state = detail.object.state ?? {};
  const title = typeof state.title === "string" ? state.title : detail.object.objectKey;
  const fields = kind === "artifact"
    ? [
        title,
        typeof state.schemaRef === "string" ? `schema: ${state.schemaRef}` : undefined,
        stringArray(state.mediaTypes).length > 0 ? `media: ${stringArray(state.mediaTypes).join(", ")}` : undefined,
        stringArray(state.requiredFields).length > 0 ? `fields: ${stringArray(state.requiredFields).join(", ")}` : undefined,
      ]
    : [
        title,
        stringArray(state.verificationModes).length > 0 ? `modes: ${stringArray(state.verificationModes).join(", ")}` : undefined,
        typeof state.resultSchemaRef === "string" ? `result: ${state.resultSchemaRef}` : undefined,
        stringArray(state.requiredInputs).length > 0 ? `inputs: ${stringArray(state.requiredInputs).join(", ")}` : undefined,
      ];
  return fields.filter(Boolean).join(" · ");
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
    goalContract: isRecord(value.goalContract)
      ? {
          summary: typeof value.goalContract.summary === "string" ? value.goalContract.summary : undefined,
          requirements: Array.isArray(value.goalContract.requirements)
            ? value.goalContract.requirements.map(goalContractRequirementView).filter((requirement): requirement is GoalContractRequirementView => Boolean(requirement))
            : [],
        }
      : undefined,
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
  };
}

function goalContractRequirementView(value: unknown): GoalContractRequirementView | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    expectedArtifacts: Array.isArray(value.expectedArtifacts)
      ? value.expectedArtifacts.map(expectedArtifactView).filter((artifact): artifact is ExpectedArtifactView => Boolean(artifact))
      : [],
  };
}

function expectedArtifactView(value: unknown): ExpectedArtifactView | null {
  if (!isRecord(value) || typeof value.description !== "string") return null;
  return {
    description: value.description,
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
  };
}

function validationBindingView(value: unknown): ValidationBindingView | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.requirementId !== "string") return null;
  if (!Array.isArray(value.criterionBindings)) return null;
  return {
    id: value.id,
    requirementId: value.requirementId,
    criterionBindings: value.criterionBindings.map(criterionBindingView).filter((binding): binding is CriterionBindingView => Boolean(binding)),
  };
}

function criterionBindingView(value: unknown): CriterionBindingView | null {
  if (!isRecord(value)
    || typeof value.artifactContractRef !== "string"
    || typeof value.artifactContractVersionRef !== "string"
    || typeof value.evaluatorProfileRef !== "string"
    || typeof value.evaluatorProfileVersionRef !== "string"
    || typeof value.verificationMode !== "string"
    || typeof value.procedureRef !== "string"
    || typeof value.independence !== "string") return null;
  const criterionContract = isRecord(value.criterionContract)
    && typeof value.criterionContract.id === "string"
    && typeof value.criterionContract.version === "number"
    && typeof value.criterionContract.observableClaim === "string"
    && typeof value.criterionContract.blocking === "boolean"
    ? {
        id: value.criterionContract.id,
        version: value.criterionContract.version,
        observableClaim: value.criterionContract.observableClaim,
        blocking: value.criterionContract.blocking,
        verificationIntent: stringArray(value.criterionContract.verificationIntent),
        requiredAssurance: stringArray(value.criterionContract.requiredAssurance),
      }
    : undefined;
  return {
    ...(criterionContract ? { criterionContract } : {}),
    artifactContractRef: value.artifactContractRef,
    artifactContractVersionRef: value.artifactContractVersionRef,
    evaluatorProfileRef: value.evaluatorProfileRef,
    evaluatorProfileVersionRef: value.evaluatorProfileVersionRef,
    verificationMode: value.verificationMode,
    procedureRef: value.procedureRef,
    expectedEvidenceKinds: stringArray(value.expectedEvidenceKinds),
    independence: value.independence,
    failureClassifications: stringArray(value.failureClassifications),
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
