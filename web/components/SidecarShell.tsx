"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { TabBar, type Tab } from "./TabBar";

export type SidecarMode = "floating" | "pinned" | "expanded" | "hidden";

export function SidecarShell({
  tabs,
  activeTabId,
  mode,
  width,
  onModeChange,
  onWidthChange,
  onWidthCommit,
  onSelectTab,
  onCloseTab,
  children,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  mode: SidecarMode;
  width: number;
  onModeChange: (mode: SidecarMode) => void;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  children: ReactNode;
}) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const stopResize = useCallback(() => {
    const cleanup = resizeCleanupRef.current;
    if (cleanup) cleanup();
  }, []);

  useEffect(() => {
    stopResize();
  }, [mode, stopResize]);

  useEffect(() => stopResize, [stopResize]);

  if (mode === "hidden") {
    return (
      <button
        data-testid="sidecar-reopen"
        type="button"
        title="Show sidecar"
        onClick={() => onModeChange("floating")}
        className="sidecar-reopen-button"
      >
        <PanelIcon />
      </button>
    );
  }

  const expanded = mode === "expanded";
  const sidecarWidth = expanded ? "min(960px, calc(100vw - 24px))" : `min(${width}px, calc(100vw - 24px))`;

  return (
    <aside
      data-testid="sidecar-shell"
      className={`sidecar-shell sidecar-${mode}`}
      style={{ width: sidecarWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        title="Resize sidecar"
        className="sidecar-resize-handle"
        onPointerDown={(event) => {
          event.preventDefault();
          stopResize();
          const startX = event.clientX;
          const startWidth = width;
          let latestWidth = startWidth;
          const move = (moveEvent: PointerEvent) => {
            const maxWidth = Math.max(320, Math.floor(window.innerWidth * 0.82));
            latestWidth = Math.min(maxWidth, Math.max(320, startWidth + (startX - moveEvent.clientX)));
            onWidthChange(latestWidth);
          };
          const cleanup = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", cleanup);
            window.removeEventListener("pointercancel", cleanup);
            resizeCleanupRef.current = null;
            onWidthCommit(latestWidth);
          };
          resizeCleanupRef.current = cleanup;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", cleanup);
          window.addEventListener("pointercancel", cleanup);
        }}
      />
      <header className="sidecar-header">
        <div className="sidecar-tabs">
          <TabBar tabs={tabs} activeTabId={activeTabId || ""} onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
        </div>
        <button type="button" title="Floating" onClick={() => onModeChange("floating")} aria-pressed={mode === "floating"}>Float</button>
        <button type="button" title="Pinned" onClick={() => onModeChange("pinned")} aria-pressed={mode === "pinned"}>Pin</button>
        <button type="button" title="Expanded" onClick={() => onModeChange("expanded")} aria-pressed={mode === "expanded"}>Expand</button>
        <button type="button" title="Hide" onClick={() => onModeChange("hidden")}>Hide</button>
      </header>
      <div className="sidecar-content">
        {children}
      </div>
      <span hidden>Files DAG History Live SSE Actions</span>
    </aside>
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}
