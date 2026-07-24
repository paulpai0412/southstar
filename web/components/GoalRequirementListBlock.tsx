"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  GoalDesignContent,
  GoalRequirementCoveragePreview,
  GoalRequirementDraftView,
  GoalRequirementSelection,
  GoalRequirementsContent,
} from "@/lib/types";
import { CoverageGraphPreview, type CoverageGraphData } from "./CoverageGraphPreview";
import type { LibraryGraphChartEdge, LibraryGraphChartNode } from "./library/LibraryGraphChart";
import { generateWorkflowDagStream, type GoalValidationProgressEvent } from "../lib/workflow/generate-stream";

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
  onGoalRequirements,
  onGoalValidationResume,
  onConfirmRequirements,
  onLibraryGraphNodeSelect,
}: {
  block: GoalRequirementsContent;
  onRequirementSelect?: (selection: GoalRequirementSelection) => void;
  onGoalRequirements?: (content: GoalRequirementsContent) => void;
  onGoalValidationResume?: (value: unknown) => void;
  onConfirmRequirements?: (confirmation: GoalRequirementsConfirmation) => void | Promise<GoalRequirementsConfirmationResult | void>;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
}) {
  const [currentBlock, setCurrentBlock] = useState(block);
  const [blockerAnswers, setBlockerAnswers] = useState<Record<string, string>>({});
  const [openQuestionAnswers, setOpenQuestionAnswers] = useState<Record<string, string>>({});
  const [blockerResolution, setBlockerResolution] = useState<{ status: "idle" | "submitting" | "resolved" | "error"; message?: string }>({ status: "idle" });
  const [goalDesignPromoted, setGoalDesignPromoted] = useState(false);
  const [confirmState, setConfirmState] = useState<"idle" | "confirming" | "confirmed" | "error">("idle");
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [confirmProgress, setConfirmProgress] = useState<GoalValidationProgressEvent | null>(null);
  useEffect(() => {
    setCurrentBlock(block);
    setBlockerAnswers(Object.fromEntries(block.draft.blockingInputs.map((_, index) => [String(index), ""])));
    setOpenQuestionAnswers(Object.fromEntries(block.draft.requirements.flatMap((requirement) => requirement.openQuestions.map((_, index) => [questionAnswerKey(requirement.id, index), ""]))));
    setBlockerResolution({ status: "idle" });
    setGoalDesignPromoted(false);
    setConfirmState("idle");
    setConfirmMessage(null);
    setConfirmProgress(null);
  }, [block.draftId, block.goalRequirementDraftHash, block.status, block.draft.revision]);

  // A UI contract confirmation changes host readiness without changing the
  // requirement draft identity. Merge that projection into the local block so
  // the Confirm button reflects the persisted contract state while preserving
  // any in-progress clarification answers.
  useEffect(() => {
    setCurrentBlock((current) => {
      if (
        current.draftId !== block.draftId
        || current.goalRequirementDraftHash !== block.goalRequirementDraftHash
        || current.draft.revision !== block.draft.revision
      ) return current;
      const sameReadiness = current.status === block.status
        && current.confirmable === block.confirmable
        && JSON.stringify(current.validationIssues ?? []) === JSON.stringify(block.validationIssues ?? [])
        && JSON.stringify(current.coveragePreview ?? []) === JSON.stringify(block.coveragePreview ?? [])
        && JSON.stringify(current.blockers ?? []) === JSON.stringify(block.blockers ?? [])
        && current.libraryImportDraftId === block.libraryImportDraftId;
      if (sameReadiness) return current;
      return {
        ...current,
        status: block.status,
        confirmable: block.confirmable,
        validationIssues: block.validationIssues,
        ...(block.coveragePreview ? { coveragePreview: block.coveragePreview } : {}),
        ...(block.blockers ? { blockers: block.blockers } : {}),
        ...(block.libraryImportDraftId ? { libraryImportDraftId: block.libraryImportDraftId } : {}),
      };
    });
  }, [block]);

  useEffect(() => {
    let cancelled = false;
    void loadAuthoritativeGoalState(block.draftId).then((authoritative) => {
      if (cancelled) return;
      if (authoritative.continuation) {
        setGoalDesignPromoted(true);
        onGoalValidationResume?.(authoritative.payload);
        return;
      }
      if (!authoritative.content || !goalRequirementsContentShouldReplace(block, authoritative.content)) return;
      setCurrentBlock(authoritative.content);
      onGoalRequirements?.(authoritative.content);
    }).catch(() => {
      // The session replay remains usable when the read model is temporarily unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, [block.draftId, block.goalRequirementDraftHash, block.draft.revision, onGoalRequirements, onGoalValidationResume]);

  const draft = currentBlock.draft;
  const coverage = useMemo(() => new Map((currentBlock.coveragePreview ?? []).map((entry) => [entry.requirementId, entry])), [currentBlock.coveragePreview]);
  const hasUnresolvedOpenQuestions = hasOpenQuestions(draft);
  const hasUnresolvedClarifications = draft.blockingInputs.length > 0 || hasUnresolvedOpenQuestions;
  const hasVisualContractIssues = currentBlock.validationIssues?.some((issue) => issue.code === "missing_ui_interaction_contract" || issue.code === "unconfirmed_ui_interaction_contract") ?? false;
  const confirmable = currentBlock.confirmable === true && draft.blockingInputs.length === 0 && !hasUnresolvedOpenQuestions;
  const requirementRows = draft.requirements
    .map((requirement, draftIndex) => ({ requirement, draftIndex }))
    .filter(({ requirement }) => requirement.status !== "superseded")
    .map(({ requirement, draftIndex }) => ({
      requirement,
      draftIndex,
      readiness: requirementReadiness(requirement, draftIndex, currentBlock),
    }));
  const completeRequirementCount = requirementRows.filter(({ readiness }) => readiness.tone === "complete").length;
  const attentionRequirementCount = requirementRows.filter(({ readiness }) => readiness.tone === "warning").length;
  const coverageGraph = useMemo(() => buildRequirementCoverageGraph(draft, currentBlock.coveragePreview), [currentBlock.coveragePreview, draft]);

  const resolveBlockers = async () => {
    if (blockerResolution.status === "submitting") return;
    const answers = [
      ...draft.blockingInputs.map((question, index) => ({ question, answer: blockerAnswers[String(index)]?.trim() ?? "" })),
      ...draft.requirements
        .filter((requirement) => requirement.status !== "superseded")
        .flatMap((requirement) => requirement.openQuestions.map((question, index) => ({
          question,
          answer: openQuestionAnswers[questionAnswerKey(requirement.id, index)]?.trim() ?? "",
        }))),
    ];
    if (answers.some(({ answer }) => answer.length === 0)) {
      setBlockerResolution({ status: "error", message: "Answer every clarification before rechecking." });
      return;
    }
    setBlockerResolution({ status: "submitting" });
    let nextBlock: GoalRequirementsContent | null = null;
    let followUp: string | null = null;
    try {
      await generateWorkflowDagStream({
        prompt: blockerRevisionPrompt(answers),
        draftId: currentBlock.draftId,
        expectedDraftHash: currentBlock.goalRequirementDraftHash,
        selectedRequirementIds: draft.requirements.filter((item) => item.status !== "superseded").map((item) => item.id),
        onMessage(text) {
          followUp = text;
        },
        onHeartbeat(heartbeat) {
          const elapsedSeconds = typeof heartbeat.elapsedMs === "number"
            ? Math.round(heartbeat.elapsedMs / 1000)
            : null;
          setBlockerResolution({
            status: "submitting",
            message: elapsedSeconds === null
              ? "Rechecking Goal Requirements…"
              : `Rechecking Goal Requirements… ${elapsedSeconds}s`,
          });
        },
        onGoalRequirements(value) {
          const content = goalRequirementsContentFromUnknown(value);
          if (!content || !goalRequirementsContentShouldReplace(currentBlock, content)) return;
          nextBlock = content;
          setCurrentBlock(content);
          onGoalRequirements?.(content);
        },
        onDone(result) {
          if (result?.kind === "needs_input" && typeof result.question === "string") followUp = result.question;
        },
      });
      if (!nextBlock) {
        const reconciled = await loadAuthoritativeGoalRequirements(currentBlock.draftId);
        if (goalRequirementsContentShouldReplace(currentBlock, reconciled)) {
          nextBlock = reconciled;
          setCurrentBlock(reconciled);
          onGoalRequirements?.(reconciled);
        }
      }
      const resolvedBlock = nextBlock as GoalRequirementsContent | null;
      if (!resolvedBlock) throw new Error(followUp ?? "Requirement revision did not return a Goal Requirements revision.");
      setBlockerResolution(resolvedBlock.draft.blockingInputs.length === 0 && !hasOpenQuestions(resolvedBlock.draft)
        ? { status: "resolved", message: `Saved revision ${resolvedBlock.draft.revision}. All goal clarifications are resolved.` }
        : { status: "error", message: followUp ?? "Some clarifications still need an answer." });
    } catch (error) {
      try {
        const reconciled = await loadAuthoritativeGoalRequirements(currentBlock.draftId);
        if (goalRequirementsContentShouldReplace(currentBlock, reconciled)) {
          setCurrentBlock(reconciled);
          onGoalRequirements?.(reconciled);
          setBlockerResolution(reconciled.draft.blockingInputs.length === 0 && !hasOpenQuestions(reconciled.draft)
            ? { status: "resolved", message: `Saved revision ${reconciled.draft.revision}. All goal clarifications are resolved.` }
            : { status: "error", message: "Some clarifications still need an answer." });
          return;
        }
      } catch {
        // Preserve the original stream error when the read model cannot reconcile it.
      }
      setBlockerResolution({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

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

  const primaryAction = hasUnresolvedClarifications
    ? {
      testId: "goal-requirement-resolve",
      disabled: blockerResolution.status === "submitting" || confirmState === "confirming",
      run: resolveBlockers,
      label: blockerResolution.status === "submitting" ? "Rechecking…" : "Answer & recheck",
    }
    : {
      testId: "goal-requirements-confirm",
      disabled: !confirmable || confirmState === "confirming" || confirmState === "confirmed",
      run: confirm,
      label: confirmState === "confirming"
        ? "Confirming…"
        : confirmState === "confirmed"
          ? "Confirmed"
          : confirmable
            ? "Confirm requirements"
            : hasVisualContractIssues
              ? "Review visual contracts first"
              : goalDesignPromoted
                ? "Slice Plan is ready below"
              : "Waiting for host readiness",
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
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
          <span style={pillStyle}>{requirementRows.length} requirements</span>
          <span data-testid="goal-requirements-readiness-summary" style={pillStyle}>
            {completeRequirementCount}/{requirementRows.length} complete{attentionRequirementCount > 0 ? ` · ${attentionRequirementCount} need attention` : ""}
          </span>
        </div>
      </header>

      <details data-testid="goal-requirements-guide" style={guideStyle}>
        <summary style={guideSummaryStyle}>How to answer blockers and complete this step</summary>
        <div style={guideBodyStyle}>
          <div><strong>1. Read each requirement.</strong> The title and statement describe the user outcome; the technical ID is only for linking.</div>
          <div><strong>2. Answer every blocker or open question.</strong> Enter one proposed option such as <code>A</code> or a short decision, then use the primary action below to recheck.</div>
          <div><strong>3. Review each visual contract.</strong> Open the UI contract, inspect its screens and states, then choose <em>Confirm visual contract</em>.</div>
          <div><strong>4. Confirm requirements.</strong> This button enables only after the host returns no unresolved inputs and all required visual contracts are confirmed.</div>
        </div>
      </details>

      <div style={metaRowStyle}>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.source === "explicit" && item.status !== "superseded").length} explicit</span>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.source === "inferred" && item.status !== "superseded").length} inferred</span>
        <span style={pillStyle}>{draft.requirements.filter((item) => item.blocking && item.status !== "superseded").length} required</span>
        {draft.blockingInputs.length > 0 ? <span style={{ ...pillStyle, color: "#fbbf24" }}>{draft.blockingInputs.length} clarification{draft.blockingInputs.length === 1 ? "" : "s"}</span> : <span style={pillStyle}>clarification clear</span>}
      </div>

      {draft.blockingInputs.length > 0 ? (
        <div data-testid="goal-requirement-blockers" style={blockerPanelStyle}>
          <strong>Resolve before confirmation</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            {draft.blockingInputs.map((input, index) => (
              <div key={`${input}-${index}`} style={blockerQuestionStyle}>
                <div style={{ ...questionTextStyle, color: "#fbbf24" }}>{input}</div>
                <label style={answerLabelStyle}>
                  Answer
                  <textarea
                    aria-label={`Answer ${index + 1}`}
                    data-testid={`goal-requirement-blocker-answer-${index}`}
                    rows={2}
                    value={blockerAnswers[String(index)] ?? ""}
                    placeholder="Choose an option or add a short answer"
                    onChange={(event) => setBlockerAnswers((current) => ({ ...current, [String(index)]: event.target.value }))}
                    style={answerInputStyle}
                  />
                </label>
              </div>
            ))}
          </div>
          <div style={helperTextStyle}>Use one option letter when the question provides options, or add a short decision. Answer every clarification, then use the primary action below to recheck the Goal Requirements revision.</div>
        </div>
      ) : null}

      <div style={listStyle}>
        {requirementRows.map(({ requirement, readiness }, index) => {
          const entry = coverage.get(requirement.id);
          const visualStatus = requirement.interactionContractRefs.length > 0 ? "visual review" : "no visual contract";
          const requirementRef = `R${index + 1}`;
          const selection: GoalRequirementSelection = {
            draftId: currentBlock.draftId,
            expectedDraftHash: currentBlock.goalRequirementDraftHash,
            requirementId: requirement.id,
            draft,
            status: currentBlock.status,
            confirmable,
            ...(currentBlock.validationIssues ? { validationIssues: currentBlock.validationIssues } : {}),
            ...(currentBlock.coveragePreview ? { coveragePreview: currentBlock.coveragePreview } : {}),
          };
          const readinessColor = readiness.tone === "warning"
            ? "#fbbf24"
            : readiness.tone === "complete"
              ? "#86efac"
              : "var(--text-dim)";
          return (
            <div key={requirement.id} style={itemContainerStyle}>
              <button
                type="button"
                data-testid={`goal-requirement-item-${requirement.id}`}
                onClick={() => onRequirementSelect?.(selection)}
                style={itemButtonStyle}
              >
                <div style={itemHeadingStyle}>
                  <strong style={{ color: "var(--text)", fontSize: 12 }}><span style={semanticRefStyle}>{requirementRef}</span> {requirement.title}</strong>
                  <span style={{ ...miniPillStyle, fontFamily: "var(--font-mono)" }}>{requirement.id}</span>
                  <span style={miniPillStyle}>{requirement.source}</span>
                  {requirement.blocking ? <span style={{ ...miniPillStyle, color: "#fbbf24" }}>required</span> : null}
                  <span
                    data-testid={`goal-requirement-status-${requirement.id}`}
                    aria-label={`${readiness.label}: ${readiness.detail}`}
                    title={readiness.detail}
                    style={{ ...miniPillStyle, color: readinessColor }}
                  >
                    <span aria-hidden="true">{readiness.icon}</span> {readiness.label}
                  </span>
                </div>
                <div style={statementStyle}>{requirement.statement}</div>
                <div data-testid={`goal-requirement-semantic-tags-${requirement.id}`} style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Semantic coverage: {requirement.semanticTags && requirement.semanticTags.length > 0 ? requirement.semanticTags.join(" · ") : "not recorded; validation will require confirmation before tagged Library reuse"}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {requirement.acceptanceCriteria.map((criterion, criterionIndex) => (
                    <div
                      key={criterion.id}
                      data-testid={`goal-requirement-criterion-${criterion.id}`}
                      style={{ border: "1px solid var(--border)", borderRadius: 7, padding: "7px 8px", background: "var(--bg-panel)", textAlign: "left" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
                        <strong style={{ color: "var(--text)", fontSize: 11 }}>C{criterionIndex + 1} · {criterion.observableClaim}</strong>
                        <span style={miniPillStyle}>{criterion.blocking ? "Required" : "Advisory"}</span>
                        <span style={miniPillStyle}>v{criterion.version}</span>
                      </div>
                      <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 10 }}>
                        Assurance: {(assuranceArray(criterion.requiredAssurance) ?? []).map(formatAssurance).join(" · ") || "not recorded"}
                      </div>
                      <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>
                        Verification: {stringArray(criterion.verificationIntent).join(" · ") || "not recorded"}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={metaRowStyle}>
                  <span style={miniPillStyle}>{requirement.acceptanceCriteria.length} AC</span>
                  <span style={miniPillStyle}>{requirement.status.replaceAll("_", " ")}</span>
                  <span style={miniPillStyle}>{coverageLabel(entry)}</span>
                  <span style={miniPillStyle}>{visualStatus}</span>
                </div>
              </button>
              {requirement.interactionContractRefs.length > 0 ? (
                <div data-testid={`goal-requirement-visual-contracts-${requirement.id}`} style={visualContractListStyle}>
                  <span style={visualContractLabelStyle}>Visual contracts</span>
                  {requirement.interactionContractRefs.map((contractId) => {
                    const contractState = visualContractState(contractId, currentBlock);
                    return (
                      <button
                        key={contractId}
                        type="button"
                        data-testid={`goal-requirement-visual-contract-${requirement.id}-${contractId}`}
                        onClick={() => onRequirementSelect?.(selection)}
                        style={{ ...visualContractButtonStyle, color: contractState.color }}
                        title="Open the requirement sidecar, then open this UI contract"
                      >
                        {contractState.icon} {contractState.label} · {contractId}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {requirement.openQuestions.length > 0 ? (
                <div data-testid={`goal-requirement-questions-${requirement.id}`} style={questionPanelStyle}>
                  <strong>Open questions</strong>
                  {requirement.openQuestions.map((question, index) => (
                    <div key={`${question}-${index}`} style={questionItemStyle}>
                      <div style={questionTextStyle}>{question}</div>
                      <label style={answerLabelStyle}>
                        Answer with an option or short reply
                        <textarea
                          aria-label={`Answer ${requirement.title} question ${index + 1}`}
                          data-testid={`goal-requirement-question-answer-${requirement.id}-${index}`}
                          rows={2}
                          placeholder="Choose an option or add a short answer"
                          value={openQuestionAnswers[questionAnswerKey(requirement.id, index)] ?? ""}
                          onChange={(event) => setOpenQuestionAnswers((current) => ({ ...current, [questionAnswerKey(requirement.id, index)]: event.target.value }))}
                          style={answerInputStyle}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <CoverageGraphPreview
        testId="goal-requirements-coverage-preview"
        persistLayoutKey={`goal-requirements-coverage:${currentBlock.draftId}:${draft.revision}`}
        nodes={coverageGraph.nodes}
        edges={coverageGraph.edges}
        description="Requirement coverage currently available from the Goal Requirements read model."
        onSelectNode={onLibraryGraphNodeSelect}
      />

      {draft.blockingInputs.length === 0 && hasUnresolvedOpenQuestions ? (
        <div data-testid="goal-requirement-open-question-resolution" style={blockerPanelStyle}>
          <strong>Resolve before confirmation</strong>
          <div style={helperTextStyle}>Use one option letter when available, or add a short decision. Answer every open question above, then use the primary action below to recheck the Goal Requirements revision.</div>
        </div>
      ) : null}

      {draft.nonGoals.length > 0 ? <p style={bodyStyle}><strong>Non-goals:</strong> {draft.nonGoals.join(" · ")}</p> : null}
      <footer style={footerStyle}>
        <div data-testid="goal-validation-progress" data-state={confirmState} data-event={confirmProgress?.event ?? ""} aria-live="polite" style={{ color: confirmState === "error" ? "#f87171" : "var(--text-dim)", fontSize: 11, minWidth: 0, overflowWrap: "anywhere" }}>
          {confirmMessage ?? blockerResolution.message ?? (confirmable
            ? "Host marked this requirement draft confirmable."
            : hasUnresolvedClarifications
            ? "Answer every listed blocker and question, then use Answer & recheck."
              : hasVisualContractIssues
                ? "Review each visual contract and confirm it before confirming requirements."
                : goalDesignPromoted
                  ? "Slice Plan is ready below. Continue with Confirm & Compose DAG."
              : "Waiting for host validation readiness.")}
        </div>
        <button
          type="button"
          data-testid={primaryAction.testId}
          disabled={primaryAction.disabled}
          onClick={() => void primaryAction.run()}
          style={{ ...confirmButtonStyle, opacity: primaryAction.disabled ? 0.55 : 1 }}
        >
          {primaryAction.label}
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

type RequirementReadiness = {
  tone: "warning" | "complete" | "neutral";
  icon: "⚠" | "✓" | "•";
  label: string;
  detail: string;
};

function requirementReadiness(
  requirement: GoalRequirementDraftView["requirements"][number],
  requirementIndex: number,
  block: GoalRequirementsContent,
): RequirementReadiness {
  const prefix = `requirements.${requirementIndex}`;
  const hasHostValidation = Array.isArray(block.validationIssues);
  const issues = (block.validationIssues ?? []).filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
  if (issues.length > 0 || requirement.openQuestions.length > 0) {
    return {
      tone: "warning",
      icon: "⚠",
      label: "Needs attention",
      detail: issues[0]?.message ?? "Answer the open question before confirmation.",
    };
  }
  if (requirement.interactionContractRefs.length > 0 && !hasHostValidation) {
    return {
      tone: "neutral",
      icon: "•",
      label: "Pending host review",
      detail: "Waiting for host visual contract readiness data.",
    };
  }
  if (requirement.status === "ready") {
    return {
      tone: "complete",
      icon: "✓",
      label: "Complete",
      detail: "Requirement is ready for confirmation.",
    };
  }
  return {
    tone: "neutral",
    icon: "•",
    label: "Pending host review",
    detail: "Waiting for host readiness data.",
  };
}

function visualContractState(contractId: string, block: GoalRequirementsContent): { icon: "⚠" | "✓"; label: string; color: string } {
  const issue = (block.validationIssues ?? []).find((entry) => (
    (entry.code === "missing_ui_interaction_contract" || entry.code === "unconfirmed_ui_interaction_contract")
    && entry.message.includes(contractId)
  ));
  return issue
    ? { icon: "⚠", label: "Needs confirmation", color: "#fbbf24" }
    : { icon: "✓", label: "Confirmed", color: "#86efac" };
}

function blockerRevisionPrompt(answers: Array<{ question: string; answer: string }>): string {
  return [
    "Resolve the goal-level clarification inputs below and return a complete revised Goal Requirements draft.",
    "Apply each answer to the relevant requirements. Remove a blocking input only when its decision is fully answered.",
    "Treat an answer as selecting one of the proposed options when possible, and remove an open question only when its decision is fully answered.",
    "This is a clarification-only revision: preserve requirement titles, statements, acceptance criteria ids/order, and interactionContractRefs unless an answer explicitly changes them.",
    "For any remaining open question or blocking input with finite choices, preserve 2-4 concise options in the question string as `Options: A) ...; B) ...`.",
    ...answers.map(({ question, answer }, index) => `${index + 1}. Question: ${question}\nAnswer: ${answer}`),
  ].join("\n");
}

type AuthoritativeGoalState = {
  payload: unknown;
  content: GoalRequirementsContent | null;
  continuation: GoalDesignContent | null;
};

async function loadAuthoritativeGoalState(draftId: string): Promise<AuthoritativeGoalState> {
  const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/orchestration`, { cache: "no-store" });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw new Error(errorMessage(payload) ?? `Goal Requirements reconciliation failed with HTTP ${response.status}`);
  const content = goalRequirementsContentFromUnknown(payload);
  const continuation = goalDesignContinuationFromUnknown(payload);
  if (!content && !continuation) throw new Error("Goal Requirements reconciliation returned an invalid draft.");
  return { payload, content, continuation };
}

async function loadAuthoritativeGoalRequirements(draftId: string): Promise<GoalRequirementsContent> {
  const authoritative = await loadAuthoritativeGoalState(draftId);
  if (!authoritative.content) throw new Error("Goal Requirements reconciliation returned a Goal Design continuation.");
  return authoritative.content;
}

function questionAnswerKey(requirementId: string, index: number): string {
  return `${requirementId}:${index}`;
}

function hasOpenQuestions(draft: GoalRequirementDraftView): boolean {
  return draft.requirements.some((requirement) => requirement.status !== "superseded" && requirement.openQuestions.length > 0);
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
  if (goalRequirementPhaseRank(incoming.status) < goalRequirementPhaseRank(current.status)) return false;
  // Multiple replayed Goal Requirement blocks can reconcile the same draft in
  // parallel. A late pre-confirmation response must not restore validation
  // issues that a newer UI-contract PATCH has already removed.
  if (current.status === incoming.status && validationProjectionIsStale(current, incoming)) return false;
  if (incoming.status !== current.status) return true;
  return JSON.stringify({
    confirmable: current.confirmable,
    validationIssues: current.validationIssues ?? [],
    blockers: current.blockers ?? [],
    coveragePreview: current.coveragePreview ?? [],
    libraryImportDraftId: current.libraryImportDraftId ?? null,
  }) !== JSON.stringify({
    confirmable: incoming.confirmable,
    validationIssues: incoming.validationIssues ?? [],
    blockers: incoming.blockers ?? [],
    coveragePreview: incoming.coveragePreview ?? [],
    libraryImportDraftId: incoming.libraryImportDraftId ?? null,
  });
}

function validationProjectionIsStale(current: GoalRequirementsContent, incoming: GoalRequirementsContent): boolean {
  if (current.confirmable && !incoming.confirmable) return true;
  const currentIssues = new Set((current.validationIssues ?? []).map((issue) => `${issue.path}\u0000${issue.code ?? ""}\u0000${issue.message}`));
  const incomingIssues = new Set((incoming.validationIssues ?? []).map((issue) => `${issue.path}\u0000${issue.code ?? ""}\u0000${issue.message}`));
  return currentIssues.size < incomingIssues.size
    && [...currentIssues].every((issue) => incomingIssues.has(issue));
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
          goalDesignPhase: "slice_review",
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
  const phase = stringValue(continued.goalDesignPhase) ?? stringValue(continued.phase);
  const packageHash = stringValue(continued.goalDesignPackageHash);
  if (!draftId || status !== "ready_for_review" || phase !== "slice_review" || !packageHash || !isRecord(continued.goalDesignPackage)) return null;
  return {
    type: "goalDesign",
    draftId,
    status,
    goalDesignPhase: "slice_review",
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
  if (value.schemaVersion !== "southstar.goal_requirement_draft.v2" || typeof value.draftHash !== "string" || !Array.isArray(value.requirements)) return null;
  if (typeof value.revision !== "number" || typeof value.originalPrompt !== "string" || typeof value.summary !== "string") return null;
  const requirements = value.requirements.map(parseRequirement).filter((item): item is GoalRequirementDraftView["requirements"][number] => Boolean(item));
  if (requirements.length !== value.requirements.length) return null;
  return {
    schemaVersion: "southstar.goal_requirement_draft.v2",
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
    if (
      !isRecord(criterion)
      || typeof criterion.id !== "string"
      || criterion.id.trim().length === 0
      || !Number.isInteger(criterion.version)
      || Number(criterion.version) < 1
      || typeof criterion.observableClaim !== "string"
      || criterion.observableClaim.trim().length === 0
      || typeof criterion.blocking !== "boolean"
    ) return null;
    const requiredAssurance = assuranceArray(criterion.requiredAssurance);
    const verificationIntent = nonEmptyStringArray(criterion.verificationIntent);
    const evidenceIntent = strictStringArray(criterion.evidenceIntent);
    if (!requiredAssurance || !verificationIntent || !evidenceIntent) return null;
    return {
      id: criterion.id,
      version: criterion.version,
      observableClaim: criterion.observableClaim,
      blocking: criterion.blocking,
      verificationIntent,
      requiredAssurance,
      evidenceIntent,
    };
  }).filter((criterion): criterion is GoalRequirementDraftView["requirements"][number]["acceptanceCriteria"][number] => Boolean(criterion));
  if (criteria.length !== value.acceptanceCriteria.length) return null;
  const status = value.status;
  if (status !== "needs_clarification" && status !== "ready" && status !== "confirmed" && status !== "superseded") return null;
  return {
    id: value.id,
    title: value.title,
    statement: value.statement,
    ...(Array.isArray(value.semanticTags) ? { semanticTags: stringArray(value.semanticTags) } : {}),
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

function buildRequirementCoverageGraph(
  draft: GoalRequirementDraftView,
  coveragePreview: GoalRequirementCoveragePreview[] | undefined,
): CoverageGraphData {
  const nodes = new Map<string, LibraryGraphChartNode>();
  const edges: LibraryGraphChartEdge[] = [];
  const edgeKeys = new Set<string>();
  const coverageByRequirement = new Map((coveragePreview ?? []).map((entry) => [entry.requirementId, entry]));
  const addNode = (node: LibraryGraphChartNode) => {
    if (!nodes.has(node.objectKey)) nodes.set(node.objectKey, node);
  };
  const addEdge = (fromObjectKey: string, toObjectKey: string, edgeType: string) => {
    const key = `${fromObjectKey}:${edgeType}:${toObjectKey}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromObjectKey, toObjectKey, edgeType });
  };

  for (const requirement of draft.requirements.filter((item) => item.status !== "superseded")) {
    const requirementKey = `requirement:${requirement.id}`;
    const coverage = coverageByRequirement.get(requirement.id);
    const blocked = coverage?.status === "missing" || requirement.status === "needs_clarification";
    addNode({
      objectKey: requirementKey,
      objectKind: "requirement",
      status: blocked ? "blocked" : requirement.status,
      title: `Requirement ${requirement.id}`,
      metadata: { title: requirement.title, statement: requirement.statement },
    });
    for (const criterion of requirement.acceptanceCriteria) {
      const criterionKey = `ac:${requirement.id}:${criterion.id}`;
      addNode({
        objectKey: criterionKey,
        objectKind: "acceptance_criteria",
        status: blocked ? "blocked" : requirement.status,
        title: `AC ${criterion.id}`,
        metadata: {
          observableClaim: criterion.observableClaim,
          blocking: criterion.blocking,
          version: criterion.version,
          verificationIntent: criterion.verificationIntent,
          requiredAssurance: criterion.requiredAssurance,
          evidenceIntent: criterion.evidenceIntent,
        },
      });
      addEdge(requirementKey, criterionKey, "has criterion");
    }
    for (const ref of coverage?.artifactRefs ?? []) {
      addNode({ objectKey: ref, objectKind: "artifact", status: blocked ? "blocked" : coverage?.status ?? "unknown", title: `Artifact ${ref}` });
      addEdge(requirementKey, ref, "covered by artifact");
    }
    for (const ref of coverage?.evaluatorRefs ?? []) {
      addNode({ objectKey: ref, objectKind: "evaluator", status: blocked ? "blocked" : coverage?.status ?? "unknown", title: `Evaluator ${ref}` });
      addEdge(requirementKey, ref, "checked by evaluator");
    }
  }

  return { nodes: [...nodes.values()], edges };
}

function isArtifact(value: unknown): value is { description: string; mediaType?: string } {
  return isRecord(value) && typeof value.description === "string" && (value.mediaType === undefined || typeof value.mediaType === "string");
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function strictStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0) ? value : null;
}
function nonEmptyStringArray(value: unknown): string[] | null {
  const items = strictStringArray(value);
  return items && items.length > 0 ? items : null;
}
function assuranceArray(value: unknown): GoalRequirementDraftView["requirements"][number]["acceptanceCriteria"][number]["requiredAssurance"] | null {
  const allowed = new Set<string>(["deterministic", "browser_interaction", "semantic_review", "human_approval"]);
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !allowed.has(item))) return null;
  return value as GoalRequirementDraftView["requirements"][number]["acceptanceCriteria"][number]["requiredAssurance"];
}
function formatAssurance(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const cardStyle = { border: "1px solid rgba(59,130,246,0.24)", borderRadius: 8, background: "rgba(59,130,246,0.045)", padding: 12, marginTop: 10 } as const;
const headerStyle = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 } as const;
const titleStyle = { margin: 0, color: "var(--text)", fontSize: 13, fontWeight: 700, lineHeight: 1.35 } as const;
const subtitleStyle = { marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" } as const;
const metaRowStyle = { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 } as const;
const pillStyle = { border: "1px solid var(--border)", borderRadius: 999, padding: "2px 7px", color: "var(--text-dim)", background: "var(--bg)", fontSize: 10, fontFamily: "var(--font-mono)" } as const;
const miniPillStyle = { ...pillStyle, borderRadius: 5, background: "rgba(0,0,0,0.08)" } as const;
const semanticRefStyle = { color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 10 } as const;
const listStyle = { display: "flex", flexDirection: "column", gap: 7, marginTop: 11 } as const;
const itemContainerStyle = { border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)" } as const;
const itemButtonStyle = { width: "100%", border: "none", borderRadius: 7, background: "var(--bg-panel)", padding: 10, cursor: "pointer", textAlign: "left" as const } as const;
const visualContractListStyle = { display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: 5, padding: "0 10px 9px" } as const;
const visualContractLabelStyle = { color: "var(--text-dim)", fontSize: 10, fontWeight: 700 } as const;
const visualContractButtonStyle = { border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", padding: "3px 6px", cursor: "pointer", fontSize: 10, fontFamily: "var(--font-mono)" } as const;
const itemHeadingStyle = { display: "flex", alignItems: "center", flexWrap: "wrap" as const, gap: 5 } as const;
const statementStyle = { marginTop: 5, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 } as const;
const blockerPanelStyle = { marginTop: 10, border: "1px solid rgba(251,191,36,0.38)", borderRadius: 7, background: "rgba(251,191,36,0.08)", padding: "8px 10px", color: "#fbbf24", fontSize: 11, lineHeight: 1.45 } as const;
const blockerQuestionStyle = { border: "1px solid rgba(251,191,36,0.28)", borderRadius: 6, padding: "7px 8px", background: "rgba(0,0,0,0.08)" } as const;
const answerLabelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, marginTop: 5, color: "var(--text-dim)", fontSize: 10 } as const;
const answerInputStyle = { width: "100%", resize: "vertical" as const, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", padding: "7px 8px", fontSize: 12, lineHeight: 1.4 } as const;
const questionPanelStyle = { marginTop: 6, borderLeft: "2px solid rgba(251,191,36,0.55)", paddingLeft: 8, color: "#fbbf24", fontSize: 11, lineHeight: 1.45 } as const;
const questionItemStyle = { marginTop: 5 } as const;
const questionTextStyle = { whiteSpace: "pre-wrap" as const } as const;
const helperTextStyle = { marginTop: 6, color: "var(--text-dim)", fontSize: 10 } as const;
const guideStyle = { marginTop: 10, border: "1px solid color-mix(in srgb, var(--accent) 22%, var(--border))", borderRadius: 7, background: "color-mix(in srgb, var(--accent) 5%, var(--bg-panel))", padding: "7px 9px" } as const;
const guideSummaryStyle = { color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 700 } as const;
const guideBodyStyle = { display: "flex", flexDirection: "column" as const, gap: 6, marginTop: 7, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 } as const;
const bodyStyle = { margin: "10px 0 0", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 } as const;
const footerStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 11 } as const;
const confirmButtonStyle = { border: "1px solid var(--accent)", borderRadius: 7, background: "var(--accent)", color: "#fff", padding: "8px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700, flexShrink: 0 } as const;
