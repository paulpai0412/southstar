export type SouthstarProductTab = "chat" | "workflow" | "operations" | "evolution";

const tabs: Array<{ id: SouthstarProductTab; label: string; description: string }> = [
  { id: "chat", label: "Chat", description: "General conversation" },
  { id: "workflow", label: "Workflow", description: "Plan and run" },
  { id: "operations", label: "Operations", description: "Control Center" },
  { id: "evolution", label: "Evolution", description: "Learning graph" },
];

export function SouthstarTabRail(props: { activeTab: SouthstarProductTab; onChange: (tab: SouthstarProductTab) => void }) {
  return (
    <aside className="ss-product-rail" aria-label="Southstar sections">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" aria-pressed={props.activeTab === tab.id} onClick={() => props.onChange(tab.id)}>
          <strong>{tab.label}</strong>
          <span>{tab.description}</span>
        </button>
      ))}
    </aside>
  );
}
