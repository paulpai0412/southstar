"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { GoalJourney, GoalJourneyStep } from "@/lib/goal-journey";

export function GoalJourneyTimeline({
  journey,
  variant,
  onStepSelect,
  onOpen,
}: {
  journey: GoalJourney;
  variant: "compact" | "detail";
  onStepSelect?: (step: GoalJourneyStep) => void;
  onOpen?: () => void;
}) {
  const detail = variant === "detail";
  const [compactOpen, setCompactOpen] = useState(false);
  useEffect(() => setCompactOpen(false), [journey.id]);
  const currentStageLabel = journey.steps.find((step) => step.id === journey.currentStage)?.label ?? journey.currentStage;
  const steps = journey.steps.map((step, index) => (
    <JourneyStep key={step.id} step={step} detail={detail} last={index === journey.steps.length - 1} onSelect={onStepSelect} />
  ));
  return (
    <section
      data-testid={`goal-journey-${variant}`}
      aria-label="Goal journey timeline"
      style={{
        position: "relative",
        padding: detail ? 16 : "0 12px",
        borderBottom: detail ? "none" : "1px solid var(--border)",
        background: detail ? "var(--bg)" : "var(--bg-panel)",
        color: "var(--text)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: detail ? undefined : 34 }}>
        {detail ? <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Goal journey
          </div>
          <strong data-testid="goal-journey-title" style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: detail ? 15 : 13 }}>
            {journey.title}
          </strong>
          <span data-testid="goal-journey-stage" style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11 }}>
            Current: {currentStageLabel}
          </span>
        </div> : (
          <button
            type="button"
            data-testid="goal-journey-toggle"
            aria-expanded={compactOpen}
            onClick={() => setCompactOpen((open) => !open)}
            style={compactToggleStyle}
          >
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>Goal</span>
            <strong data-testid="goal-journey-title" style={compactTitleStyle}>{journey.title}</strong>
            <span data-testid="goal-journey-stage" style={compactStageStyle}>· {currentStageLabel}</span>
            <span aria-hidden="true" style={{ color: "var(--text-dim)", transform: compactOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>⌄</span>
          </button>
        )}
        {onOpen && !detail ? (
          <button type="button" data-testid="goal-journey-open" onClick={onOpen} style={buttonStyle}>
            View timeline
          </button>
        ) : null}
      </div>

      {detail ? (
        <details data-testid="goal-journey-guide" style={journeyGuideStyle}>
          <summary style={journeyGuideSummaryStyle}>How to follow this goal across screens</summary>
          <div style={journeyGuideBodyStyle}>
            <div><strong>Chat</strong> captures the goal prompt; <strong>Requirements</strong> confirms what success means; <strong>Library</strong> imports approved capabilities and coverage.</div>
            <div><strong>Workflow</strong> turns the approved slices into a DAG; <strong>Operator</strong> runs and evaluates it. Click a linked stage to open its existing session or run.</div>
            <div>The same readable goal title is the cross-screen anchor. Session IDs and run IDs remain technical details for tracing, not the primary label.</div>
          </div>
        </details>
      ) : null}

      {detail ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 18 }}>{steps}</div>
      ) : compactOpen ? (
        <div data-testid="goal-journey-compact-steps" style={compactStepsStyle}>{steps}</div>
      ) : null}
    </section>
  );
}

function JourneyStep({
  step,
  detail,
  last,
  onSelect,
}: {
  step: GoalJourneyStep;
  detail: boolean;
  last: boolean;
  onSelect?: (step: GoalJourneyStep) => void;
}) {
  const clickable = Boolean(onSelect && (step.sessionId || step.runId));
  const contentStyle: CSSProperties = {
    display: "flex",
    alignItems: detail ? "flex-start" : "center",
    gap: detail ? 10 : 7,
    minWidth: detail ? 0 : 132,
    flex: detail ? undefined : "0 0 132px",
    color: step.status === "pending" ? "var(--text-dim)" : "var(--text)",
    textAlign: "left",
  };

  return (
    <div data-testid={`goal-journey-step-${step.id}`} style={{ display: "flex", flexDirection: detail ? "row" : "column", alignItems: detail ? "stretch" : "center", flex: detail ? undefined : "0 0 132px", minWidth: detail ? 0 : 132 }}>
      <button
        type="button"
        disabled={!clickable}
        aria-current={step.status === "current" ? "step" : undefined}
        aria-label={`${step.label}: ${step.description}`}
        onClick={() => onSelect?.(step)}
        style={{ ...contentStyle, width: detail ? undefined : "100%", cursor: clickable ? "pointer" : "default", border: "none", background: "transparent", padding: detail ? "7px 4px" : 0, borderRadius: 6 }}
      >
        <span
          aria-hidden="true"
          style={{
            width: detail ? 24 : 20,
            height: detail ? 24 : 20,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            borderRadius: "50%",
            border: `1px solid ${step.status === "pending" ? "var(--border)" : "var(--accent)"}`,
            background: step.status === "current" ? "var(--accent)" : step.status === "complete" ? "color-mix(in srgb, var(--accent) 14%, var(--bg))" : "var(--bg)",
            color: step.status === "current" ? "#fff" : "var(--accent)",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {step.status === "complete" ? "✓" : step.status === "current" ? "•" : ""}
        </span>
        <span style={{ minWidth: 0, display: "flex", flexDirection: detail ? "column" : "row", alignItems: detail ? "flex-start" : "center", gap: detail ? 2 : 4 }}>
          <strong style={{ fontSize: detail ? 12 : 11, fontWeight: step.status === "current" ? 700 : 560, whiteSpace: "nowrap" }}>{step.label}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: detail ? "normal" : "nowrap" }}>{step.description}</span>
        </span>
      </button>
      {!last ? <span aria-hidden="true" style={{ width: detail ? 1 : 18, height: detail ? 12 : 1, flex: detail ? "0 0 12px" : "0 0 18px", margin: detail ? "0 0 0 15px" : "0 8px", background: "var(--border)" }} /> : null}
    </div>
  );
}

const buttonStyle: CSSProperties = {
  flexShrink: 0,
  padding: "5px 9px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
};

const compactToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
  flex: 1,
  height: 34,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 11,
};

const compactTitleStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text)",
  fontSize: 12,
};

const compactStageStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--text-dim)",
  fontSize: 10,
  whiteSpace: "nowrap",
};

const compactStepsStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 100,
  display: "flex",
  gap: 0,
  overflowX: "auto",
  padding: "8px 12px 10px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-panel)",
  boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
};

const journeyGuideStyle: CSSProperties = {
  marginTop: 12,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.45,
};

const journeyGuideSummaryStyle: CSSProperties = { cursor: "pointer", padding: "7px 9px", color: "var(--text)" };
const journeyGuideBodyStyle: CSSProperties = { display: "grid", gap: 5, padding: "0 9px 9px" };
