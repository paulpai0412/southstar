"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  GoalDesignContent,
  GoalRequirementCoveragePreview,
  GoalRequirementDraftView,
  GoalRequirementSelection,
  GoalRequirementsContent,
} from "@/lib/types";
import type { GoalValidationProgressEvent } from "@/lib/workflow/generate-stream";

export type GoalRequirementsConfirmation = {
  draftId: string;
  expectedDraftHash: string;
  draft: GoalRequirementDraftView;
  onProgress?: (progress: GoalValidationProgressEvent) => void;
};

export type GoalRequirementsConfirmationResult = GoalRequirementsContent | GoalDesignContent;

export function GoalRequirementListBlock({
  block,
  onRequirementSelect,
  onConfirmRequirements,
}: {
  block: GoalRequirementsContent;
  onRequirementSelect?: (selection: GoalRequirementSelection) => void;
  onConfirmRequirements?: (confirmation: GoalRequirementsConfirmation) => void | Promise<GoalRequirementsConfirmationResult | void>;
}) {
  const [currentBlock, setCurrentBlock] = useState(block);
  const [confirmState, setConfirmState] = useState<"idle" | "confirming" | "confirmed" | "error">("idle");
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [confirmProgress, setConfirmProgress] = useState<GoalValidationProgressEvent | null>(null);
  useEffect(() => {
    setCurrentBlock(block);
    setConfirmState("idle");
    setConfirmMessage(null);
    setConfirmProgress(null);
  }, [block]);
  const draft = currentBlock.draft;
  const coverage = useMemo(() => new Map((currentBlock.coveragePreview ?? []).map((entry) => [entry.requirementId, entry])), [currentBlock.coveragePreview]);
  const hasUnresolvedBlockingQuestions = draft.requirements.some((item) => item.status !== "superseded" && item.blocking && item.openQuestions.length > 0);
  const confirmable = currentBlock.confirmable === true && draft.blockingInputs.length === 0 && !hasUnresolvedBlockingQuestions;

  const confirm = async () => {
    if (!confirmable || confirmState === "confirming") return;
    setConfirmState("confirming");
    setConfirmMessage(null);
    const confirmation: GoalRequirementsConfirmation = {
      draftId: currentBlock.draftId,
      expectedDraftHash: currentBlock.goalRequirementDraftHash,
      draft,
      onProgress(progress) {
        setConfirmProgress(progress);
        setConfirmMessage(goalValidationProgressMessage(progress));
      },
    };
    try {
      if (onConfirmRequirements) {
        const value = await onConfirmRequirements(confirmation);
        const next = isConfirmationResult(value)
          ? value
          : goalRequirementsConfirmationFromUnknown(value, confirmation);
        if (!next) throw new Error("Requirement confirmation response did not include a valid lifecycle transition.");
        assertConfirmationResult(next, currentBlock);
        if (next.type === "goalRequirements") setCurrentBlock(next);
      } else {
        const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(currentBlock.draftId)}/confirm-requirements`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedDraftHash: currentBlock.goalRequirementDraftHash }),
        });
        const payload = await response.json().catch(() => undefined) as unknown;
        if (!response.ok) throw new Error(errorMessage(payload) ?? `HTTP ${response.status}`);
        const next = goalRequirementsConfirmationFromUnknown(payload, confirmation);
        if (!next) throw new Error("Requirement confirmation response did not include a valid lifecycle transition.");
        assertConfirmationResult(next, currentBlock);
        if (next.type === "goalRequirements") setCurrentBlock(next);
      }
      setConfirmState("confirmed");
      setConfirmMessage("Requirements confirmed; advancing Goal validation.");
    } catch (error) {
      setConfirmState("error");
      setConfirmMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section data-testid="goal-requirements-block" style={cardStyle}>
      <header style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <h3 style={titleStyle}>{draft.summary || "Goal requirements"}</h3>
          <div style={subtitleStyle}>
            draft {currentBlock.draftId} · {currentBlock.status} · rev {draft.revision}
          </div>
        </div>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.status !== "superseded").length} requirements</span>
      </header>

      <div style={metaRowStyle}>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.source === "explicit" && item.status !== "superseded").length} explicit</span>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.source === "inferred" && item.status !== "superseded").length} inferred</span>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.blocking && item.status !== "superseded").length} blocking</span>
        {draft.blockingInputs.length > 0 ? <span style={{ ...pillStyle, color: "#fbbf24" }}>{draft.blockingInputs.length} clarification{draft.blockingInputs.length === 1 ? "" : "s"}</span> : <span style={pillStyle}>clarification clear</span>}
      </div>

      {draft.blockingInputs.length > 0 ? (
        <div data-testid="goal-requirement-blockers" style={blockerPanelStyle}>
          <strong>Resolve before confirmation</strong>
          <ul style={questionListStyle}>
            {draft.blockingInputs.map((input, index) => <li key={`${input}-${index}`}>{input}</li>)}
          </ul>
          <div style={helperTextStyle}>Answer these clarifications in the editor or Workflow chat, then save the revised requirements.</div>
        </div>
      ) : null}

      <div style={listStyle}>
        {draft.requirements.filter((item) => item.status !== "superseded").map((requirement) => {
          const entry = coverage.get(requirement.id);
          const visualStatus = requirement.interactionContractRefs.length > 0 ? "visual review" : "no visual contract";
          return (
            <button
              key={requirement.id}
              type="button"
              data-testid={`goal-requirement-item-${requirement.id}`}
              onClick={() => onRequirementSelect?.({
                draftId: currentBlock.draftId,
                expectedDraftHash: currentBlock.goalRequirementDraftHash,
                requirementId: requirement.id,
                draft,
                status: currentBlock.status,
                confirmable,
                ...(currentBlock.validationIssues ? { validationIssues: currentBlock.validationIssues } : {}),
                ...(currentBlock.coveragePreview ? { coveragePreview: currentBlock.coveragePreview } : {}),
              })}
              style={itemButtonStyle}
            >
              <div style={itemHeadingStyle}>
                <strong style={{ color: "var(--text)", fontSize: 12 }}>{requirement.title}</strong>
                <span style={miniPillStyle}>{requirement.source}</span>
                {requirement.blocking ? <span style={{ ...miniPillStyle, color: "#fbbf24" }}>blocking</span> : null}
              </div>
              <div style={statementStyle}>{requirement.statement}</div>
              <div style={metaRowStyle}>
                <span style={miniPillStyle}>{requirement.acceptanceCriteria.length} AC</span>
                <span style={miniPillStyle}>{requirement.status.replaceAll("_", " ")}</span>
                <span style={miniPillStyle}>{coverageLabel(entry)}</span>
                <span style={miniPillStyle}>{visualStatus}</span>
              </div>
              {requirement.openQuestions.length > 0 ? (
                <div data-testid={`goal-requirement-questions-${requirement.id}`} style={questionPanelStyle}>
                  <strong>Open questions</strong>
                  <ul style={questionListStyle}>
                    {requirement.openQuestions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}
                  </ul>
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {draft.nonGoals.length > 0 ? <p style={bodyStyle}><strong>Non-goals:</strong> {draft.nonGoals.join(" · ")}</p> : null}
      <footer style={footerStyle}>
        <div data-testid="goal-validation-progress" data-event={confirmProgress?.event ?? ""} aria-live="polite" style={{ color: confirmState === "error" ? "#f87171" : "var(--text-dim)", fontSize: 11, minWidth: 0, overflowWrap: "anywhere" }}>
          {confirmMessage ?? (confirmable
            ? "Host marked this requirement draft confirmable."
            : draft.blockingInputs.length > 0 || hasUnresolvedBlockingQuestions
              ? "Resolve the listed blockers and questions before confirming."
              : "Waiting for host validation readiness.")}
        </div>
        <button
          type="button"
          data-testid="goal-requirements-confirm"
          disabled={!confirmable || confirmState === "confirming" || confirmState === "confirmed"}
          onClick={() => void confirm()}
          style={{ ...confirmButtonStyle, opacity: confirmable && confirmState !== "confirming" && confirmState !== "confirmed" ? 1 : 0.55 }}
        >
          {confirmState === "confirming" ? "Confirming…" : confirmState === "confirmed" ? "Confirmed" : "Confirm requirements"}
        </button>
      </footer>
    </section>
  );
}

function goalValidationProgressMessage(progress: GoalValidationProgressEvent): string {
  if (progress.event === "heartbeat") {
    return `Resolving validation coverage… ${Math.round((typeof progress.elapsedMs === "number" ? progress.elapsedMs : 0) / 1000)}s`;
  }
  if (progress.event === "goal.validation.started") return "Confirming the Requirement contract…";
  if (progress.event === "goal.validation.requirements_confirmed") return "Requirement contract confirmed; loading approved validation candidates…";
  if (progress.event === "goal.validation.candidates.loaded") return "Approved validation candidates loaded.";
  if (progress.event === "goal.validation.requirement.started") {
    const current = typeof progress.requirementNumber === "number" ? progress.requirementNumber : "?";
    const total = typeof progress.requirementCount === "number" ? progress.requirementCount : "?";
    return `Resolving Requirement ${current}/${total}${progress.requirementId ? ` · ${progress.requirementId}` : ""}…`;
  }
  if (progress.event === "goal.validation.requirement.completed") {
    return `Requirement ${progress.requirementId ?? ""} coverage ${progress.status ?? "resolved"} · ${progress.gapCount ?? 0} gap(s).`;
  }
  if (progress.event === "goal.validation.resolution.completed") return "Requirement coverage resolution completed.";
  if (progress.event === "goal.validation.library_review") return "A complete Library proposal is ready for review.";
  if (progress.event === "goal.validation.slice_design.started") return "Validation is ready; designing the slice plan…";
  if (progress.event === "library.import.candidates.repair.started") return "Revising the Library proposal against host validation issues…";
  if (progress.event === "library.import.candidates.validated") return "Library proposal passed coverage validation.";
  if (progress.event.startsWith("library.import.")) return "Preparing the complete Library validation proposal…";
  return progress.event;
}

function extractContent(value: unknown, previous: GoalRequirementsContent): GoalRequirementsContent | null {
  const envelope = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(envelope)) return null;
  const nested = isRecord(envelope.package) ? envelope.package : envelope;
  const rawDraft = isRecord(nested.goalRequirementDraft)
    ? nested.goalRequirementDraft
    : isRecord(envelope.goalRequirementDraft)
      ? envelope.goalRequirementDraft
      : isRecord(envelope.draft)
        ? envelope.draft
        : undefined;
  if (!rawDraft) return null;
  const draft = parseDraft(rawDraft);
  if (!draft) return null;
  const phase = stringValue(envelope.phase);
  const statusValue = stringValue(envelope.status);
  if (phase && statusValue && phase !== statusValue) return null;
  const status = phase ?? statusValue;
  const draftHash = stringValue(envelope.goalRequirementDraftHash) ?? stringValue(nested.goalRequirementDraftHash);
  const draftId = stringValue(envelope.draftId);
  if (!draftId || (previous.draftId && draftId !== previous.draftId) || !status || !draftHash || draftHash !== draft.draftHash) return null;
  if (typeof envelope.confirmable !== "boolean" || !Array.isArray(envelope.validationIssues)) return null;
  if (envelope.validationIssues.some((item) => !isRecord(item) || typeof item.path !== "string" || typeof item.message !== "string")) return null;
  return {
    type: "goalRequirements",
    draftId,
    status,
    goalRequirementDraftHash: draftHash,
    draft,
    coveragePreview: parseCoverage(envelope.coveragePreview ?? nested.coveragePreview) ?? previous.coveragePreview,
    confirmable: envelope.confirmable,
    validationIssues: envelope.validationIssues.filter((item): item is { path: string; message: string; code?: string } => isRecord(item) && typeof item.path === "string" && typeof item.message === "string").map((item) => ({ path: item.path as string, message: item.message as string, ...(typeof item.code === "string" ? { code: item.code } : {}) })),
    blockers: Array.isArray(envelope.blockers) ? envelope.blockers.filter((item): item is string => typeof item === "string") : previous.blockers,
    ...(typeof envelope.libraryImportDraftId === "string" ? { libraryImportDraftId: envelope.libraryImportDraftId } : {}),
  };
}

function assertConfirmationResult(content: GoalRequirementsConfirmationResult, previous: GoalRequirementsContent): void {
  if (content.type === "goalDesign") {
    if (content.draftId !== previous.draftId || content.status !== "ready_for_review" || !content.goalDesignPackageHash || content.package === undefined) {
      throw new Error("Requirement confirmation response did not preserve the draft or enter slice review.");
    }
    return;
  }
  if (typeof content.confirmable !== "boolean") {
    throw new Error("Requirement confirmation response did not include host confirmation state.");
  }
  if (content.draftId !== previous.draftId || content.goalRequirementDraftHash !== previous.goalRequirementDraftHash) {
    throw new Error("Requirement confirmation response did not preserve the displayed draft identity.");
  }
  if (content.status !== "validation_resolving" && content.status !== "library_review" && content.status !== "validation_ready") {
    throw new Error("Requirement confirmation response did not enter a validation phase.");
  }
}

export function goalRequirementsContentFromUnknown(value: unknown): GoalRequirementsContent | null {
  return extractContent(value, {
    type: "goalRequirements",
    draftId: "",
    status: "requirements_review",
    goalRequirementDraftHash: "",
    draft: {} as GoalRequirementDraftView,
    confirmable: false,
    validationIssues: [],
  });
}

/**
 * Keep the host projection monotonic when duplicate SSE/replay frames arrive
 * out of order. Equal-revision content must preserve the same draft identity
 * and cannot move a requirement draft back to an earlier design phase.
 */
export function goalRequirementsContentShouldReplace(
  current: GoalRequirementsContent | null,
  incoming: GoalRequirementsContent,
): boolean {
  if (!current || current.draftId !== incoming.draftId) return true;
  if (current.draft.revision > incoming.draft.revision) return false;
  if (current.draft.revision < incoming.draft.revision) return true;
  if (current.goalRequirementDraftHash !== incoming.goalRequirementDraftHash) return false;
  return goalRequirementPhaseRank(incoming.status) >= goalRequirementPhaseRank(current.status);
}

export function goalRequirementsConfirmationFromUnknown(
  value: unknown,
  expected: { draftId: string; expectedDraftHash: string },
): GoalRequirementsConfirmationResult | null {
  const envelope = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (isRecord(envelope)) {
    const phase = stringValue(envelope.phase);
    const status = stringValue(envelope.status);
    if (phase === "slice_review" && status === "ready_for_review") {
      const draftId = stringValue(envelope.draftId);
      const requirementDraftHash = stringValue(envelope.goalRequirementDraftHash);
      const packageHash = stringValue(envelope.goalDesignPackageHash);
      if (draftId === expected.draftId && requirementDraftHash === expected.expectedDraftHash && packageHash && isRecord(envelope.goalDesignPackage)) {
        return {
          type: "goalDesign",
          draftId,
          status,
          goalDesignPackageHash: packageHash,
          package: envelope.goalDesignPackage,
        };
      }
      return null;
    }
  }
  const content = goalRequirementsContentFromUnknown(value);
  if (!content) return null;
  if (content.draftId !== expected.draftId || content.goalRequirementDraftHash !== expected.expectedDraftHash) return null;
  if (content.status !== "validation_resolving" && content.status !== "library_review" && content.status !== "validation_ready") return null;
  return content;
}

export function goalDesignContinuationFromUnknown(value: unknown): GoalDesignContent | null {
  const envelope = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(envelope)) return null;
  const continued = isRecord(envelope.continued) ? envelope.continued : envelope;
  const draftId = stringValue(continued.draftId);
  const status = stringValue(continued.status);
  const phase = stringValue(continued.phase);
  const packageHash = stringValue(continued.goalDesignPackageHash);
  if (!draftId || status !== "ready_for_review" || phase !== "slice_review" || !packageHash || !isRecord(continued.goalDesignPackage)) return null;
  return {
    type: "goalDesign",
    draftId,
    status,
    goalDesignPackageHash: packageHash,
    package: continued.goalDesignPackage,
  };
}

export function goalValidationResumeFromUnknown(value: unknown): {
  draftId: string;
  status: string;
  libraryImportDraftId?: string;
  ok: boolean;
  error?: string;
} | null {
  const envelope = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(envelope)) return null;
  const draftId = stringValue(envelope.draftId);
  const status = stringValue(envelope.status) ?? stringValue(envelope.goalDesignPhase);
  if (!draftId || !status || typeof envelope.ok !== "boolean") return null;
  return {
    draftId,
    status,
    ok: envelope.ok,
    ...(stringValue(envelope.libraryImportDraftId) ? { libraryImportDraftId: stringValue(envelope.libraryImportDraftId) } : {}),
    ...(stringValue(envelope.error) ? { error: stringValue(envelope.error) } : {}),
  };
}

function isConfirmationResult(value: unknown): value is GoalRequirementsConfirmationResult {
  return isRecord(value) && (value.type === "goalRequirements" || value.type === "goalDesign");
}

function goalRequirementPhaseRank(status: string): number {
  switch (status) {
    case "requirements_review": return 0;
    case "requirements_confirmed": return 1;
    case "validation_resolving": return 2;
    case "library_review": return 3;
    case "validation_ready": return 4;
    case "slice_review": return 5;
    case "ready_to_compose": return 6;
    case "composing": return 7;
    case "dag_validated": return 8;
    default: return -1;
  }
}

function parseDraft(value: Record<string, unknown>): GoalRequirementDraftView | null {
  if (value.schemaVersion !== "southstar.goal_requirement_draft.v1" || typeof value.draftHash !== "string" || !Array.isArray(value.requirements)) return null;
  if (typeof value.revision !== "number" || typeof value.originalPrompt !== "string" || typeof value.summary !== "string") return null;
  const requirements = value.requirements.map(parseRequirement).filter((item): item is GoalRequirementDraftView["requirements"][number] => Boolean(item));
  if (requirements.length !== value.requirements.length) return null;
  return {
    schemaVersion: "southstar.goal_requirement_draft.v1",
    revision: value.revision,
    ...(typeof value.parentRevision === "number" ? { parentRevision: value.parentRevision } : {}),
    originalPrompt: value.originalPrompt,
    workspace: isRecord(value.workspace) && typeof value.workspace.cwd === "string" ? { cwd: value.workspace.cwd, ...(typeof value.workspace.projectRef === "string" ? { projectRef: value.workspace.projectRef } : {}) } : { cwd: "" },
    summary: value.summary,
    requirements,
    nonGoals: stringArray(value.nonGoals),
    blockingInputs: stringArray(value.blockingInputs),
    draftHash: value.draftHash,
  };
}

function parseRequirement(value: unknown): GoalRequirementDraftView["requirements"][number] | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.statement !== "string") return null;
  if (value.source !== "explicit" && value.source !== "inferred") return null;
  if (typeof value.blocking !== "boolean" || !Array.isArray(value.acceptanceCriteria)) return null;
  const criteria = value.acceptanceCriteria.map((criterion) => {
    if (!isRecord(criterion) || typeof criterion.id !== "string" || typeof criterion.statement !== "string") return null;
    return { id: criterion.id, statement: criterion.statement, evidenceIntent: stringArray(criterion.evidenceIntent) };
  }).filter((criterion): criterion is { id: string; statement: string; evidenceIntent: string[] } => Boolean(criterion));
  if (criteria.length !== value.acceptanceCriteria.length) return null;
  const status = value.status;
  if (status !== "needs_clarification" && status !== "ready" && status !== "confirmed" && status !== "superseded") return null;
  return {
    id: value.id,
    title: value.title,
    statement: value.statement,
    source: value.source,
    blocking: value.blocking,
    userVisibleBehaviors: stringArray(value.userVisibleBehaviors),
    businessRules: stringArray(value.businessRules),
    acceptanceCriteria: criteria,
    expectedOutcomeArtifacts: Array.isArray(value.expectedOutcomeArtifacts) ? value.expectedOutcomeArtifacts.filter(isArtifact) : [],
    verificationIntent: stringArray(value.verificationIntent),
    assumptions: stringArray(value.assumptions),
    openQuestions: stringArray(value.openQuestions),
    riskTags: stringArray(value.riskTags),
    interactionContractRefs: stringArray(value.interactionContractRefs),
    status,
  };
}

function parseCoverage(value: unknown): GoalRequirementCoveragePreview[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is GoalRequirementCoveragePreview => (
    isRecord(entry) && typeof entry.requirementId === "string" &&
    (entry.status === "ready" || entry.status === "partial" || entry.status === "missing" || entry.status === "manual" || entry.status === "unknown")
  )).map((entry) => ({
    requirementId: entry.requirementId,
    status: entry.status,
    missingKinds: stringArray(entry.missingKinds),
    artifactRefs: stringArray(entry.artifactRefs),
    evaluatorRefs: stringArray(entry.evaluatorRefs),
    ...(typeof entry.blocking === "boolean" ? { blocking: entry.blocking } : {}),
  }));
}

function coverageLabel(entry: GoalRequirementCoveragePreview | undefined): string {
  if (!entry) return "coverage unknown";
  if (entry.missingKinds && entry.missingKinds.length > 0) {
    return `${entry.missingKinds.map((kind) => kind.charAt(0).toUpperCase() + kind.slice(1)).join(", ")} missing`;
  }
  return entry.status;
}

function isArtifact(value: unknown): value is { description: string; mediaType?: string } {
  return isRecord(value) && typeof value.description === "string" && (value.mediaType === undefined || typeof value.mediaType === "string");
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const cardStyle = { border: "1px solid rgba(59,130,246,0.24)", borderRadius: 8, background: "rgba(59,130,246,0.045)", padding: 12, marginTop: 10 } as const;
const headerStyle = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 } as const;
const titleStyle = { margin: 0, color: "var(--text)", fontSize: 13, fontWeight: 700, lineHeight: 1.35 } as const;
const subtitleStyle = { marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" } as const;
const metaRowStyle = { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 } as const;
const pillStyle = { border: "1px solid var(--border)", borderRadius: 999, padding: "2px 7px", color: "var(--text-dim)", background: "var(--bg)", fontSize: 10, fontFamily: "var(--font-mono)" } as const;
const miniPillStyle = { ...pillStyle, borderRadius: 5, background: "rgba(0,0,0,0.08)" } as const;
const listStyle = { display: "flex", flexDirection: "column", gap: 7, marginTop: 11 } as const;
const itemButtonStyle = { width: "100%", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)", padding: 10, cursor: "pointer", textAlign: "left" as const } as const;
const itemHeadingStyle = { display: "flex", alignItems: "center", flexWrap: "wrap" as const, gap: 5 } as const;
const statementStyle = { marginTop: 5, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 } as const;
const blockerPanelStyle = { marginTop: 10, border: "1px solid rgba(251,191,36,0.38)", borderRadius: 7, background: "rgba(251,191,36,0.08)", padding: "8px 10px", color: "#fbbf24", fontSize: 11, lineHeight: 1.45 } as const;
const questionPanelStyle = { marginTop: 6, borderLeft: "2px solid rgba(251,191,36,0.55)", paddingLeft: 8, color: "#fbbf24", fontSize: 11, lineHeight: 1.45 } as const;
const questionListStyle = { margin: "4px 0 0", paddingLeft: 17 } as const;
const helperTextStyle = { marginTop: 6, color: "var(--text-dim)", fontSize: 10 } as const;
const bodyStyle = { margin: "10px 0 0", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 } as const;
const footerStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 11 } as const;
const confirmButtonStyle = { border: "1px solid var(--accent)", borderRadius: 7, background: "var(--accent)", color: "#fff", padding: "8px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700, flexShrink: 0 } as const;
