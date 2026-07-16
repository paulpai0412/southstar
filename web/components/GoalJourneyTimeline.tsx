"use client";

import type { CSSProperties } from "react";
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
  return (
    <section
      data-testid={`goal-journey-${variant}`}
      aria-label="Goal journey timeline"
      style={{
        padding: detail ? 16 : "10px 16px",
        borderBottom: detail ? "none" : "1px solid var(--border)",
        background: detail ? "var(--bg)" : "var(--bg-panel)",
        color: "var(--text)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Goal journey
          </div>
          <strong data-testid="goal-journey-title" style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: detail ? 15 : 13 }}>
            {journey.title}
          </strong>
          <span data-testid="goal-journey-stage" style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11 }}>
            Current: {journey.steps.find((step) => step.id === journey.currentStage)?.label ?? journey.currentStage}
          </span>
        </div>
        {onOpen && !detail ? (
          <button type="button" data-testid="goal-journey-open" onClick={onOpen} style={buttonStyle}>
            View timeline
          </button>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: detail ? "column" : "row",
          gap: detail ? 4 : 0,
          marginTop: detail ? 18 : 10,
          overflowX: detail ? "visible" : "auto",
          paddingBottom: detail ? 0 : 2,
        }}
      >
        {journey.steps.map((step, index) => (
          <JourneyStep key={step.id} step={step} detail={detail} last={index === journey.steps.length - 1} onSelect={onStepSelect} />
        ))}
      </div>
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
