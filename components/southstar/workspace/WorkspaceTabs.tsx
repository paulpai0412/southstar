"use client";

export type SouthstarWorkspaceViewId = "chat" | "workflow" | "operator";

const tabs: Array<{ id: SouthstarWorkspaceViewId; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "workflow", label: "Workflow" },
  { id: "operator", label: "Operator" },
];

export function WorkspaceTabs(props: {
  active: SouthstarWorkspaceViewId;
  onSelect: (id: SouthstarWorkspaceViewId) => void;
}) {
  return (
    <nav className="ss-workspace-tabs" aria-label="Southstar workspace tabs">
      {tabs.map((tab) => {
        const isActive = props.active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className="ss-workspace-tab"
            aria-pressed={isActive}
            data-active={isActive ? "true" : "false"}
            onClick={() => props.onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
