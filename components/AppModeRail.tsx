"use client";

import type { ReactNode } from "react";

export type AppMode = "chat" | "workflow" | "operator";

const MODES: Array<{
  id: AppMode;
  label: string;
  title: string;
  icon: ReactNode;
}> = [
  {
    id: "chat",
    label: "Chat",
    title: "Chat",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      </svg>
    ),
  },
  {
    id: "workflow",
    label: "Workflow",
    title: "Workflow",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="12" r="2" />
        <circle cx="12" cy="6" r="2" />
        <circle cx="18" cy="12" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M8 12h8" />
        <path d="m10.6 7.4 2.8 3.2" />
        <path d="m13.4 13.4-2.8 3.2" />
      </svg>
    ),
  },
  {
    id: "operator",
    label: "Operator",
    title: "Operator monitor",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 14h3l2-4 2 4h3" />
      </svg>
    ),
  },
];

export function AppModeRail({
  mode,
  onModeChange,
  orientation = "vertical",
}: {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  orientation?: "vertical" | "horizontal";
}) {
  const horizontal = orientation === "horizontal";

  return (
    <div
      data-testid="app-mode-rail"
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: horizontal ? 0 : 4,
        height: horizontal ? "100%" : undefined,
        padding: horizontal ? 0 : "8px 8px 6px",
        borderBottom: horizontal ? "none" : "1px solid var(--border)",
      }}
    >
      {MODES.map((item) => (
        <button
          key={item.id}
          data-testid={`mode-${item.id}`}
          aria-pressed={mode === item.id}
          onClick={() => onModeChange(item.id)}
          disabled={item.id === "operator"}
          title={item.id === "operator" ? "Operator mode is outside this implementation cycle" : item.title}
          style={{
            height: horizontal ? "100%" : 28,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: horizontal ? "0 12px" : "0 8px",
            borderRadius: horizontal ? 0 : 6,
            border: "none",
            borderTop: horizontal ? (mode === item.id ? "2px solid var(--accent)" : "2px solid transparent") : "none",
            borderRight: horizontal ? "1px solid var(--border)" : "none",
            background: mode === item.id ? "var(--bg-selected)" : "transparent",
            color: mode === item.id ? "var(--text)" : "var(--text-muted)",
            cursor: item.id === "operator" ? "not-allowed" : "pointer",
            opacity: item.id === "operator" ? 0.45 : 1,
            fontSize: 12,
            fontWeight: mode === item.id ? 650 : 500,
            textAlign: horizontal ? "center" : "left",
            transition: "color 0.12s, background 0.12s",
          }}
          onMouseEnter={(event) => {
            if (item.id === "operator") return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = mode === item.id ? "var(--text)" : "var(--text-muted)";
          }}
        >
          <span style={{ display: "flex", alignItems: "center", color: mode === item.id ? "var(--accent)" : "var(--text-dim)" }}>
            {item.icon}
          </span>
          {item.label}
        </button>
      ))}
    </div>
  );
}
