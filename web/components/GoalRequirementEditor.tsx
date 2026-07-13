"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { GoalRequirementDraftView, GoalRequirementSelection } from "@/lib/types";

type RequirementForm = {
  title: string;
  statement: string;
  userVisibleBehaviors: string;
  businessRules: string;
  acceptanceCriteria: string;
  evidenceIntent: string;
  expectedOutcomeArtifacts: string;
  verificationIntent: string;
  assumptions: string;
  openQuestions: string;
  riskTags: string;
  interactionContractRefs: string;
};

export function GoalRequirementEditor({
  selection,
  onDraftChange,
}: {
  selection: GoalRequirementSelection;
  onDraftChange?: (selection: GoalRequirementSelection) => void;
}) {
  const requirement = useMemo(() => selection.draft.requirements.find((item) => item.id === selection.requirementId) ?? null, [selection.draft, selection.requirementId]);
  const [form, setForm] = useState<RequirementForm>(() => requirement ? formFromRequirement(requirement) : emptyForm());
  const [state, setState] = useState<{ status: "idle" | "saving" | "saved" | "error"; message?: string }>({ status: "idle" });

  useEffect(() => {
    setForm(requirement ? formFromRequirement(requirement) : emptyForm());
    setState({ status: "idle" });
  }, [requirement, selection.expectedDraftHash]);

  if (!requirement) {
    return <div data-testid="goal-requirement-editor" style={shellStyle}><Header title="Requirement" subtitle={selection.requirementId} /><p style={emptyStyle}>This requirement is no longer available in the attached draft.</p></div>;
  }

  const save = async () => {
    if (state.status === "saving") return;
    setState({ status: "saving" });
    try {
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(selection.draftId)}/goal-requirements/${encodeURIComponent(selection.requirementId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDraftHash: selection.expectedDraftHash, patch: patchFromForm(form) }),
      });
      const payload = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) throw new Error(errorMessage(payload) ?? `HTTP ${response.status}`);
      const next = selectionFromResponse(payload, selection);
      if (!next) throw new Error("Requirement save response did not include a valid goal requirement draft.");
      onDraftChange?.(next);
      setState({ status: "saved", message: `Saved revision ${next.draft.revision}` });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div data-testid="goal-requirement-editor" style={shellStyle}>
      <Header title={requirement.title} subtitle={`${requirement.id} · ${requirement.source}${requirement.blocking ? " · blocking" : ""}`} />
      <div style={contentStyle}>
        <Field label="Title"><input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} style={inputStyle} /></Field>
        <Field label="Statement"><textarea value={form.statement} onChange={(event) => setForm((current) => ({ ...current, statement: event.target.value }))} rows={4} style={textareaStyle} /></Field>
        <Field label="User-visible behaviors"><ListField value={form.userVisibleBehaviors} onChange={(value) => setForm((current) => ({ ...current, userVisibleBehaviors: value }))} /></Field>
        <Field label="Business rules"><ListField value={form.businessRules} onChange={(value) => setForm((current) => ({ ...current, businessRules: value }))} /></Field>
        <Field label="Acceptance criteria"><ListField value={form.acceptanceCriteria} onChange={(value) => setForm((current) => ({ ...current, acceptanceCriteria: value }))} /></Field>
        <Field label="Evidence intent"><ListField value={form.evidenceIntent} onChange={(value) => setForm((current) => ({ ...current, evidenceIntent: value }))} /></Field>
        <Field label="Expected artifacts"><ListField value={form.expectedOutcomeArtifacts} onChange={(value) => setForm((current) => ({ ...current, expectedOutcomeArtifacts: value }))} placeholder="Description | mediaType" /></Field>
        <Field label="Verification intent"><ListField value={form.verificationIntent} onChange={(value) => setForm((current) => ({ ...current, verificationIntent: value }))} /></Field>
        <Field label="Assumptions"><ListField value={form.assumptions} onChange={(value) => setForm((current) => ({ ...current, assumptions: value }))} /></Field>
        <Field label="Open questions"><ListField value={form.openQuestions} onChange={(value) => setForm((current) => ({ ...current, openQuestions: value }))} /></Field>
        <Field label="Risk tags"><ListField value={form.riskTags} onChange={(value) => setForm((current) => ({ ...current, riskTags: value }))} /></Field>
        <Field label="Interaction contract refs"><ListField value={form.interactionContractRefs} onChange={(value) => setForm((current) => ({ ...current, interactionContractRefs: value }))} /></Field>
      </div>
      <footer style={footerStyle}>
        <div style={{ color: state.status === "error" ? "#f87171" : "var(--text-dim)", fontSize: 11, overflowWrap: "anywhere", minWidth: 0 }}>{state.message ?? `expected draft ${selection.expectedDraftHash.slice(0, 12)}`}</div>
        <button type="button" data-testid="goal-requirement-save" disabled={state.status === "saving"} onClick={() => void save()} style={{ ...saveButtonStyle, opacity: state.status === "saving" ? 0.55 : 1 }}>{state.status === "saving" ? "Saving…" : "Save requirement"}</button>
      </footer>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return <header style={headerStyle}><div style={{ minWidth: 0 }}><div style={headerTitleStyle}>{title}</div>{subtitle ? <div style={headerSubtitleStyle}>{subtitle}</div> : null}</div></header>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={fieldStyle}><span style={fieldLabelStyle}>{label}</span>{children}</label>;
}

function ListField({ value, onChange, placeholder = "One item per line" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} style={textareaStyle} placeholder={placeholder} />;
}

function formFromRequirement(requirement: GoalRequirementDraftView["requirements"][number]): RequirementForm {
  return {
    title: requirement.title,
    statement: requirement.statement,
    userVisibleBehaviors: requirement.userVisibleBehaviors.join("\n"),
    businessRules: requirement.businessRules.join("\n"),
    acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.statement).join("\n"),
    evidenceIntent: requirement.acceptanceCriteria.flatMap((criterion) => criterion.evidenceIntent).join("\n"),
    expectedOutcomeArtifacts: requirement.expectedOutcomeArtifacts.map((artifact) => artifact.mediaType ? `${artifact.description} | ${artifact.mediaType}` : artifact.description).join("\n"),
    verificationIntent: requirement.verificationIntent.join("\n"),
    assumptions: requirement.assumptions.join("\n"),
    openQuestions: requirement.openQuestions.join("\n"),
    riskTags: requirement.riskTags.join("\n"),
    interactionContractRefs: requirement.interactionContractRefs.join("\n"),
  };
}

function emptyForm(): RequirementForm {
  return { title: "", statement: "", userVisibleBehaviors: "", businessRules: "", acceptanceCriteria: "", evidenceIntent: "", expectedOutcomeArtifacts: "", verificationIntent: "", assumptions: "", openQuestions: "", riskTags: "", interactionContractRefs: "" };
}

function patchFromForm(form: RequirementForm): Record<string, unknown> {
  const criteria = lines(form.acceptanceCriteria).map((statement, index) => ({ id: `criterion-${index + 1}`, statement, evidenceIntent: lines(form.evidenceIntent) }));
  return {
    title: form.title.trim(),
    statement: form.statement.trim(),
    userVisibleBehaviors: lines(form.userVisibleBehaviors),
    businessRules: lines(form.businessRules),
    acceptanceCriteria: criteria,
    expectedOutcomeArtifacts: lines(form.expectedOutcomeArtifacts).map((value) => {
      const [description, mediaType] = value.split("|").map((item) => item.trim());
      return mediaType ? { description, mediaType } : { description };
    }),
    verificationIntent: lines(form.verificationIntent),
    assumptions: lines(form.assumptions),
    openQuestions: lines(form.openQuestions),
    riskTags: lines(form.riskTags),
    interactionContractRefs: lines(form.interactionContractRefs),
  };
}

function selectionFromResponse(value: unknown, previous: GoalRequirementSelection): GoalRequirementSelection | null {
  const envelope = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(envelope) || !isRecord(envelope.goalRequirementDraft)) return null;
  const draft = envelope.goalRequirementDraft as unknown as GoalRequirementDraftView;
  if (typeof draft.draftHash !== "string" || !Array.isArray(draft.requirements)) return null;
  return {
    ...previous,
    expectedDraftHash: typeof envelope.goalRequirementDraftHash === "string" ? envelope.goalRequirementDraftHash : draft.draftHash,
    draft,
    ...(typeof envelope.phase === "string" || typeof envelope.status === "string"
      ? { status: typeof envelope.phase === "string" ? envelope.phase : envelope.status as string }
      : {}),
    ...(typeof envelope.confirmable === "boolean" ? { confirmable: envelope.confirmable } : {}),
  };
}

function lines(value: string): string[] { return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean); }
function errorMessage(value: unknown): string | undefined { return isRecord(value) && typeof value.error === "string" ? value.error : isRecord(value) && typeof value.message === "string" ? value.message : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const shellStyle = { height: "100%", display: "flex", flexDirection: "column" as const, minHeight: 0, background: "var(--bg)" } as const;
const headerStyle = { display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" } as const;
const headerTitleStyle = { fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } as const;
const headerSubtitleStyle = { marginTop: 2, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const } as const;
const contentStyle = { flex: 1, minHeight: 0, overflow: "auto", padding: 12, display: "flex", flexDirection: "column" as const, gap: 12 } as const;
const fieldStyle = { display: "flex", flexDirection: "column" as const, gap: 5 } as const;
const fieldLabelStyle = { color: "var(--text-dim)", fontSize: 11, fontWeight: 650 } as const;
const inputStyle = { width: "100%", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", padding: "7px 8px", fontSize: 12 } as const;
const textareaStyle = { width: "100%", resize: "vertical" as const, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", padding: "7px 8px", fontSize: 12, lineHeight: 1.45 } as const;
const footerStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" } as const;
const saveButtonStyle = { border: "1px solid var(--accent)", borderRadius: 7, background: "var(--accent)", color: "#fff", padding: "8px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700, flexShrink: 0 } as const;
const emptyStyle = { padding: 12, color: "var(--text-muted)", fontSize: 12 } as const;
