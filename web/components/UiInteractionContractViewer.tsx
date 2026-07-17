"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { UiInteractionContractSelection, UiInteractionContractView } from "@/lib/types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; contract: UiInteractionContractView }
  | { status: "error"; message: string };

const KNOWN_ELEMENT_TYPES = new Set([
  "button", "input", "textarea", "select", "checkbox", "text", "heading", "list", "card", "form", "table", "image", "link", "status",
]);

export function UiInteractionContractViewer({
  selection,
  onReviewChange,
}: {
  selection: UiInteractionContractSelection;
  onReviewChange?: (value: unknown) => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [screenId, setScreenId] = useState("");
  const [screenState, setScreenState] = useState("");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadContract = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const response = await fetch(contractPath(selection));
      const body = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) throw new Error(errorMessage(body) ?? `HTTP ${response.status}`);
      const contract = contractFromEnvelope(body);
      if (!contract) throw new Error("UI contract response is invalid.");
      setLoad({ status: "ready", contract });
    } catch (error) {
      setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [selection.contractId, selection.draftId]);

  useEffect(() => { void loadContract(); }, [loadContract]);

  const contract = load.status === "ready" ? load.contract : null;
  const screen = useMemo(() => contract?.screens.find((entry) => entry.id === screenId) ?? contract?.screens[0] ?? null, [contract, screenId]);
  const selectedElement = screen?.elements.find((entry) => entry.id === selectedElementId) ?? null;

  useEffect(() => {
    if (!contract) return;
    const nextScreen = contract.screens.find((entry) => entry.id === screenId) ?? contract.screens[0];
    if (!nextScreen) return;
    if (screenId !== nextScreen.id) setScreenId(nextScreen.id);
    if (!nextScreen.states.includes(screenState)) setScreenState(nextScreen.states[0] ?? "");
    if (selectedElementId && !nextScreen.elements.some((entry) => entry.id === selectedElementId)) setSelectedElementId(null);
  }, [contract, screenId, screenState, selectedElementId]);

  const patch = async (operation: Record<string, unknown>) => {
    if (!contract || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(contractPath(selection), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedContractHash: contract.contractHash, patch: operation }),
      });
      const body = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) throw new Error(errorMessage(body) ?? `HTTP ${response.status}`);
      const result = resultFromEnvelope(body);
      const next = contractFromReviewResult(result, selection.contractId);
      if (!next) throw new Error("UI contract patch response did not include the revised contract.");
      setLoad({ status: "ready", contract: next });
      setMessage(`Saved revision ${next.revision}`);
      onReviewChange?.(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (load.status === "loading") return <ViewerFrame expanded={expanded}><Centered>Loading UI interaction contract…</Centered></ViewerFrame>;
  if (load.status === "error") {
    return <ViewerFrame expanded={expanded}><Centered><div>{load.message}</div><button type="button" onClick={() => void loadContract()} style={secondaryButton}>Retry</button></Centered></ViewerFrame>;
  }
  if (!contract) return <ViewerFrame expanded={expanded}><Centered>UI interaction contract is unavailable.</Centered></ViewerFrame>;

  return (
    <ViewerFrame expanded={expanded}>
      <div data-testid="ui-interaction-contract-viewer" style={shellStyle}>
        <header style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={titleStyle}>UI contract · {screen?.title ?? "Untitled screen"}</div>
            <div style={{ ...subtitleStyle, fontFamily: "inherit", whiteSpace: "normal" }}>{screen?.purpose ?? "Review the screen behavior and confirm it matches the requirement."}</div>
            <div style={subtitleStyle}>{contract.id} · requirements {contract.requirementIds.join(", ")} · revision {contract.revision} · {contract.status}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setExpanded((value) => !value)} style={secondaryButton}>{expanded ? "Collapse" : "Expand"}</button>
            {contract.status !== "confirmed" ? <button type="button" data-testid="ui-contract-confirm" disabled={saving} onClick={() => void patch({ kind: "confirm" })} style={primaryButton}>Confirm visual contract</button> : null}
          </div>
        </header>

        <details data-testid="ui-contract-guide" style={guideStyle}>
          <summary style={guideSummaryStyle}>How to review this UI contract</summary>
          <div style={guideBodyStyle}>
            <div><strong>Screen:</strong> the user-facing page or panel for this requirement.</div>
            <div><strong>State:</strong> the situation being checked, such as empty, loading, error, or completed.</div>
            <div><strong>Preview:</strong> click a visible element to inspect its label, enabled state, and transition action.</div>
            <div><strong>Confirm visual contract:</strong> choose this only when the screen purpose, states, actions, and accessibility behavior match the requirement. This is what enables requirement confirmation.</div>
          </div>
        </details>

        <div style={toolbarStyle}>
          <label style={controlLabel}>Screen<select value={screen?.id ?? ""} onChange={(event) => { setScreenId(event.target.value); setSelectedElementId(null); }} style={selectStyle}>{contract.screens.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {entry.id}</option>)}</select></label>
          <label style={controlLabel}>State<select value={screenState} onChange={(event) => setScreenState(event.target.value)} style={selectStyle}>{screen?.states.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{screen?.states.map((state) => <button key={state} type="button" data-testid={`ui-state-${state}`} onClick={() => setScreenState(state)} style={state === screenState ? selectedToggle : secondaryButton}>{state}</button>)}</div>
          <div style={{ display: "flex", gap: 4 }}>{(["desktop", "mobile"] as const).map((value) => <button key={value} type="button" data-testid={`ui-viewport-${value}`} onClick={() => setViewport(value)} style={value === viewport ? selectedToggle : secondaryButton}>{value}</button>)}</div>
        </div>

        <div style={workspaceStyle}>
          <main style={previewColumnStyle}>
            <div style={{ ...previewFrameStyle, width: viewport === "mobile" ? 375 : "100%", maxWidth: "100%" }}>
              <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 750 }}>{screen?.title}</div>
                <div style={{ marginTop: 3, color: "var(--text-muted)", fontSize: 11 }}>{screen?.purpose}</div>
              </div>
              {screen?.layout.regions.map((region) => (
                <section key={region.id} data-region-id={region.id} style={regionStyle}>
                  <div style={regionLabelStyle}>{region.role} · {region.position} · {region.id}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {region.childRefs.map((elementId) => {
                      const element = screen.elements.find((entry) => entry.id === elementId);
                      if (!element || !element.visibleInStates.includes(screenState) || !KNOWN_ELEMENT_TYPES.has(element.type)) return null;
                      return <ElementPreview key={element.id} element={element} enabled={element.enabledInStates.includes(screenState)} selected={selectedElementId === element.id} onSelect={() => setSelectedElementId(element.id)} />;
                    })}
                  </div>
                </section>
              ))}
            </div>
            <div style={ruleGridStyle}>
              <RuleList title="Responsive" values={screen?.responsiveRules ?? []} />
              <RuleList title="Accessibility" values={screen?.accessibilityRules ?? []} />
            </div>
          </main>

          <aside style={inspectorStyle}>
            {selectedElement && screen ? (
              <ElementInspector
                key={`${contract.contractHash}:${screen.id}:${selectedElement.id}`}
                screen={screen}
                element={selectedElement}
                saving={saving}
                onSave={(elementPatch) => void patch({ kind: "update_element", screenId: screen.id, elementId: selectedElement.id, patch: elementPatch })}
              />
            ) : <div style={mutedStyle}>Select a visible element to edit its label and state rules.</div>}
            {screen ? <ActionInspector screen={screen} saving={saving} onSave={(actionId, actionPatch) => void patch({ kind: "update_action", screenId: screen.id, actionId, patch: actionPatch })} onPreviewState={setScreenState} /> : null}
            <section style={metaSectionStyle}><div style={sectionTitleStyle}>Criterion bindings</div>{contract.criterionBindings.map((binding) => <div key={binding.criterionId} style={metaItemStyle}><strong>{binding.criterionId}</strong><div>{[...binding.screenIds, ...binding.elementIds, ...binding.actionIds].join(" · ")}</div></div>)}</section>
            <section style={metaSectionStyle}><div style={sectionTitleStyle}>Flows</div>{contract.flows.map((flow) => <div key={flow.id} style={metaItemStyle}><strong>{flow.id}</strong><div>{flow.steps.join(" → ")}</div><div>{flow.successOutcome}</div></div>)}</section>
          </aside>
        </div>
        <footer style={footerStyle}><span style={{ color: message?.toLowerCase().includes("error") ? "#f87171" : "var(--text-dim)" }}>{message ?? `requirements: ${contract.requirementIds.join(", ")}`}</span></footer>
      </div>
    </ViewerFrame>
  );
}

function ElementPreview({ element, enabled, selected, onSelect }: { element: UiInteractionContractView["screens"][number]["elements"][number]; enabled: boolean; selected: boolean; onSelect: () => void }) {
  const common = { "data-element-id": element.id, "data-element-type": element.type, onClick: onSelect, style: { ...elementStyle, outline: selected ? "2px solid var(--accent)" : "1px solid var(--border)", opacity: enabled ? 1 : 0.55 } };
  const label = element.label ?? element.id;
  if (element.type === "heading") return <h3 {...common}>{label}</h3>;
  if (element.type === "input") return <input {...common} aria-label={label} placeholder={label} disabled={!enabled} readOnly />;
  if (element.type === "textarea") return <textarea {...common} aria-label={label} placeholder={label} disabled={!enabled} readOnly />;
  if (element.type === "select") return <select {...common} aria-label={label} disabled={!enabled}><option>{label}</option></select>;
  if (element.type === "checkbox") return <label {...common}><input type="checkbox" disabled={!enabled} readOnly /> {label}</label>;
  if (element.type === "button") return <button {...common} type="button" disabled={!enabled}>{label}</button>;
  if (element.type === "link") return <button {...common} type="button" disabled={!enabled}>{label}</button>;
  return <div {...common}>{label}<div style={{ fontSize: 9, opacity: 0.65 }}>{element.type} · {element.id}</div></div>;
}

function ElementInspector({ screen, element, saving, onSave }: {
  screen: UiInteractionContractView["screens"][number];
  element: UiInteractionContractView["screens"][number]["elements"][number];
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [label, setLabel] = useState(element.label ?? "");
  const [visible, setVisible] = useState(element.visibleInStates);
  const [enabled, setEnabled] = useState(element.enabledInStates);
  const toggle = (values: string[], value: string, checked: boolean) => checked ? [...new Set([...values, value])] : values.filter((entry) => entry !== value);
  return <section style={metaSectionStyle} data-testid="ui-element-inspector"><div style={sectionTitleStyle}>Element · {element.id}</div><label style={controlLabel}>Label<input value={label} onChange={(event) => setLabel(event.target.value)} style={inputStyle} /></label><div style={stateGridStyle}>{screen.states.map((state) => <div key={state} style={stateRowStyle}><span>{state}</span><label><input type="checkbox" checked={visible.includes(state)} onChange={(event) => { const next = toggle(visible, state, event.target.checked); setVisible(next); if (!event.target.checked) setEnabled((current) => current.filter((entry) => entry !== state)); }} /> visible</label><label><input type="checkbox" checked={enabled.includes(state)} disabled={!visible.includes(state)} onChange={(event) => setEnabled((current) => toggle(current, state, event.target.checked))} /> enabled</label></div>)}</div><button type="button" disabled={saving} onClick={() => onSave({ label: label.trim() || undefined, visibleInStates: visible, enabledInStates: enabled })} style={primaryButton}>Save element</button></section>;
}

function ActionInspector({ screen, saving, onSave, onPreviewState }: { screen: UiInteractionContractView["screens"][number]; saving: boolean; onSave: (id: string, patch: Record<string, unknown>) => void; onPreviewState: (state: string) => void }) {
  return <section style={metaSectionStyle}><div style={sectionTitleStyle}>Actions</div>{screen.actions.map((action) => <ActionRow key={action.id} screen={screen} action={action} saving={saving} onSave={onSave} onPreviewState={onPreviewState} />)}</section>;
}

function ActionRow({ screen, action, saving, onSave, onPreviewState }: { screen: UiInteractionContractView["screens"][number]; action: UiInteractionContractView["screens"][number]["actions"][number]; saving: boolean; onSave: (id: string, patch: Record<string, unknown>) => void; onPreviewState: (state: string) => void }) {
  const [trigger, setTrigger] = useState(action.triggerElementId); const [from, setFrom] = useState(action.fromState); const [to, setTo] = useState(action.toState); const [effect, setEffect] = useState(action.expectedEffect);
  return <div style={metaItemStyle}><strong>{action.id}</strong><label style={controlLabel}>Trigger<select value={trigger} onChange={(event) => setTrigger(event.target.value)} style={selectStyle}>{screen.elements.map((element) => <option key={element.id}>{element.id}</option>)}</select></label><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}><label style={controlLabel}>From<select value={from} onChange={(event) => setFrom(event.target.value)} style={selectStyle}>{screen.states.map((state) => <option key={state}>{state}</option>)}</select></label><label style={controlLabel}>To<select value={to} onChange={(event) => setTo(event.target.value)} style={selectStyle}>{screen.states.map((state) => <option key={state}>{state}</option>)}</select></label></div><label style={controlLabel}>Expected effect<input value={effect} onChange={(event) => setEffect(event.target.value)} style={inputStyle} /></label><div style={{ display: "flex", gap: 6 }}><button type="button" data-testid={`ui-action-${action.id}`} onClick={() => onPreviewState(to)} style={secondaryButton}>Preview transition</button><button type="button" disabled={saving} onClick={() => onSave(action.id, { triggerElementId: trigger, fromState: from, toState: to, expectedEffect: effect })} style={primaryButton}>Save action</button></div></div>;
}

function RuleList({ title, values }: { title: string; values: string[] }) { return <section style={metaSectionStyle}><div style={sectionTitleStyle}>{title}</div>{values.length ? values.map((value) => <div key={value} style={metaItemStyle}>{value}</div>) : <div style={mutedStyle}>None</div>}</section>; }
function ViewerFrame({ expanded, children }: { expanded: boolean; children: ReactNode }) { return <div style={expanded ? expandedFrameStyle : embeddedFrameStyle}>{children}</div>; }
function Centered({ children }: { children: ReactNode }) { return <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10, alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 16, textAlign: "center" }}>{children}</div>; }

function contractPath(selection: UiInteractionContractSelection): string { return `/api/workflow/planner-drafts/${encodeURIComponent(selection.draftId)}/ui-contracts/${encodeURIComponent(selection.contractId)}`; }
function resultFromEnvelope(value: unknown): unknown { return isRecord(value) && "result" in value ? value.result : value; }
function contractFromEnvelope(value: unknown): UiInteractionContractView | null { return contractFromUnknown(resultFromEnvelope(value)); }
function contractFromReviewResult(value: unknown, contractId: string): UiInteractionContractView | null { if (!isRecord(value) || !Array.isArray(value.uiInteractionContracts)) return null; return value.uiInteractionContracts.map(contractFromUnknown).find((entry) => entry?.id === contractId) ?? null; }
function contractFromUnknown(value: unknown): UiInteractionContractView | null { if (!isRecord(value) || value.schemaVersion !== "southstar.ui_interaction_contract.v1" || typeof value.id !== "string" || typeof value.contractHash !== "string" || !Array.isArray(value.screens) || !Array.isArray(value.flows) || !Array.isArray(value.criterionBindings)) return null; return value as unknown as UiInteractionContractView; }
function errorMessage(value: unknown): string | undefined { return isRecord(value) && typeof value.error === "string" ? value.error : isRecord(value) && typeof value.message === "string" ? value.message : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const embeddedFrameStyle = { height: "100%", minHeight: 0, background: "var(--bg)" } as const;
const expandedFrameStyle = { position: "fixed" as const, inset: 24, zIndex: 200, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 24px 70px rgba(0,0,0,.45)", overflow: "hidden" } as const;
const shellStyle = { height: "100%", minHeight: 0, display: "flex", flexDirection: "column" as const, background: "var(--bg)" } as const;
const headerStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" } as const;
const titleStyle = { fontSize: 13, fontWeight: 750, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" } as const;
const subtitleStyle = { marginTop: 3, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)" } as const;
const toolbarStyle = { display: "flex", alignItems: "end", flexWrap: "wrap" as const, gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" } as const;
const workspaceStyle = { flex: 1, minHeight: 0, overflow: "hidden", display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(260px, .7fr)" } as const;
const previewColumnStyle = { minWidth: 0, overflow: "auto", padding: 14, display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 12 } as const;
const previewFrameStyle = { minHeight: 320, padding: 14, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", transition: "width .15s ease" } as const;
const regionStyle = { marginBottom: 10, padding: 10, border: "1px dashed var(--border)", borderRadius: 7, background: "var(--bg)" } as const;
const regionLabelStyle = { marginBottom: 8, color: "var(--text-dim)", fontSize: 9, fontFamily: "var(--font-mono)", textTransform: "uppercase" as const } as const;
const elementStyle = { boxSizing: "border-box" as const, width: "100%", minHeight: 34, padding: "7px 9px", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", textAlign: "left" as const, cursor: "pointer" } as const;
const inspectorStyle = { minWidth: 0, overflow: "auto", padding: 12, borderLeft: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" as const, gap: 10 } as const;
const metaSectionStyle = { padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", display: "flex", flexDirection: "column" as const, gap: 8 } as const;
const sectionTitleStyle = { fontSize: 11, fontWeight: 750, color: "var(--text)" } as const;
const metaItemStyle = { padding: 7, borderRadius: 5, background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 10, overflowWrap: "anywhere" as const, display: "flex", flexDirection: "column" as const, gap: 4 } as const;
const controlLabel = { display: "flex", flexDirection: "column" as const, gap: 4, color: "var(--text-dim)", fontSize: 10 } as const;
const inputStyle = { width: "100%", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)", padding: "6px 7px", fontSize: 11 } as const;
const selectStyle = { ...inputStyle, minWidth: 110 } as const;
const primaryButton = { border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "#fff", padding: "6px 9px", cursor: "pointer", fontSize: 10, fontWeight: 700 } as const;
const secondaryButton = { border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", padding: "6px 9px", cursor: "pointer", fontSize: 10 } as const;
const selectedToggle = { ...secondaryButton, borderColor: "var(--accent)", color: "var(--accent)" } as const;
const stateGridStyle = { display: "flex", flexDirection: "column" as const, gap: 4 } as const;
const stateRowStyle = { display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", color: "var(--text-muted)", fontSize: 10 } as const;
const mutedStyle = { color: "var(--text-dim)", fontSize: 10 } as const;
const ruleGridStyle = { width: "100%", display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 } as const;
const footerStyle = { flexShrink: 0, padding: "7px 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)", fontSize: 10, overflowWrap: "anywhere" as const } as const;
const guideStyle = { flexShrink: 0, margin: "8px 12px 0", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 } as const;
const guideSummaryStyle = { cursor: "pointer", padding: "7px 9px", color: "var(--text)" } as const;
const guideBodyStyle = { display: "grid", gap: 5, padding: "0 9px 9px" } as const;
