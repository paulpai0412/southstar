"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildNodeProfilePatchPayload,
  formEquals,
  normalizeNodeProfileForm,
  type WorkflowNodeProfileForm,
} from "@/lib/workflow/node-profile";

type ProfileOption = {
  id: string;
  model?: string;
};

const emptyForm: WorkflowNodeProfileForm = {
  provider: "",
  model: "",
  thinkingLevel: "",
  instruction: "",
  skillRefs: [],
  mcpGrantRefs: [],
};

export function WorkflowNodeProfileEditor({
  draftId,
  runId,
  taskId,
  mode,
}: {
  draftId?: string;
  runId?: string;
  taskId: string;
  mode: "draft" | "runtime";
}) {
  const [form, setForm] = useState<WorkflowNodeProfileForm>(emptyForm);
  const [serverForm, setServerForm] = useState<WorkflowNodeProfileForm>(emptyForm);
  const [selectedDefinition, setSelectedDefinition] = useState<unknown>(null);
  const [candidates, setCandidates] = useState<unknown>(null);
  const [skillInput, setSkillInput] = useState("");
  const [mcpInput, setMcpInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedDefinitionRecord = recordValue(selectedDefinition);
  const candidateAlternatives = recordValue(recordValue(candidates)?.alternatives);
  const editable = mode === "draft" && Boolean(draftId) && selectedDefinitionRecord?.editable !== false;
  const dirty = !formEquals(form, serverForm);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const query = new URLSearchParams({ taskId });
      if (draftId) query.set("draftId", draftId);
      if (runId) query.set("runId", runId);
      const response = await fetch(`/api/workflow/ui?${query.toString()}`);
      const payload = await response.json() as unknown;
      const payloadRecord = recordValue(payload);
      if (!response.ok || payloadRecord?.ok === false) throw new Error(stringValue(payloadRecord?.error) || `HTTP ${response.status}`);
      const model = payloadRecord?.result ?? payload;
      const selected = recordValue(model)?.selectedDefinition ?? null;
      const nextForm = normalizeNodeProfileForm({ selectedDefinition: selected });
      setSelectedDefinition(selected);
      setForm(nextForm);
      setServerForm(nextForm);

      if (draftId) {
        const candidateQuery = new URLSearchParams({ draftId, taskId });
        const candidateResponse = await fetch(`/api/workflow/agent-library/candidates?${candidateQuery.toString()}`);
        const candidatePayload = await candidateResponse.json() as unknown;
        const candidateRecord = recordValue(candidatePayload);
        if (candidateResponse.ok && candidateRecord?.ok !== false) setCandidates(candidateRecord?.result ?? candidatePayload);
      } else {
        setCandidates(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [draftId, runId, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const profileOptions = useMemo(() => {
    const list = candidateAlternatives?.agentProfiles;
    return Array.isArray(list) ? list.map(readProfileOption).filter((profile): profile is ProfileOption => profile !== null) : [];
  }, [candidateAlternatives]);

  const save = async () => {
    if (!draftId || !editable) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/tasks/${encodeURIComponent(taskId)}/profile-override`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildNodeProfilePatchPayload(form)),
      });
      const payload = await response.json() as unknown;
      const payloadRecord = recordValue(payload);
      const result = recordValue(payloadRecord?.result);
      if (!response.ok || payloadRecord?.ok === false) throw new Error(stringValue(payloadRecord?.error) || `HTTP ${response.status}`);
      window.dispatchEvent(new CustomEvent("southstar:planner-draft-updated", {
        detail: {
          draftId,
          status: stringValue(result?.status) || stringValue(payloadRecord?.status) || "needs_validation",
        },
      }));
      setNotice("Saved");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<WorkflowNodeProfileForm>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const addRef = (field: "skillRefs" | "mcpGrantRefs", value: string) => {
    const ref = value.trim();
    if (!ref) return;
    setForm((current) => ({ ...current, [field]: [...new Set([...current[field], ref])] }));
    if (field === "skillRefs") setSkillInput("");
    else setMcpInput("");
  };

  const removeRef = (field: "skillRefs" | "mcpGrantRefs", value: string) => {
    setForm((current) => ({ ...current, [field]: current[field].filter((item) => item !== value) }));
  };

  if (loading) {
    return <div data-testid="workflow-node-profile-editor" style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;
  }

  return (
    <div data-testid="workflow-node-profile-editor" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {stringValue(selectedDefinitionRecord?.taskName) || taskId}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {mode} / {taskId}
          </div>
        </div>
        <button data-testid="workflow-node-profile-reset" onClick={() => setForm(serverForm)} disabled={!dirty || saving} style={buttonStyle(!dirty || saving)}>
          Reset
        </button>
        <button data-testid="workflow-node-profile-save" onClick={() => void save()} disabled={!dirty || !editable || saving} style={buttonStyle(!dirty || !editable || saving)}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 14 }}>
        {!editable && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, color: "var(--text-muted)", fontSize: 12, background: "var(--bg-panel)" }}>
            Runtime tasks are read-only. Edit the planner draft before creating a run.
          </div>
        )}
        {error && <div style={{ color: "#ef4444", fontSize: 12 }}>{error}</div>}
        {notice && <div style={{ color: "var(--accent)", fontSize: 12 }}>{notice}</div>}
        <section style={sectionStyle}>
          <label style={labelStyle}>Host adapter</label>
          <select value={form.provider} disabled={!editable} onChange={(event) => update({ provider: event.currentTarget.value })} style={inputStyle}>
            <option value="">Default</option>
            {["pi", "codex", "claude-code", "openai", "anthropic", "custom"].map((provider) => (
              <option key={provider} value={provider}>{provider}</option>
            ))}
          </select>
          <label style={labelStyle}>Model</label>
          <input value={form.model} disabled={!editable} onChange={(event) => update({ model: event.currentTarget.value })} style={inputStyle} />
          <label style={labelStyle}>Thinking mode</label>
          <input value={form.thinkingLevel} disabled={!editable} onChange={(event) => update({ thinkingLevel: event.currentTarget.value })} placeholder="auto, low, medium, high" style={inputStyle} />
        </section>
        <section style={sectionStyle}>
          <label style={labelStyle}>Instruction</label>
          <textarea value={form.instruction} disabled={!editable} onChange={(event) => update({ instruction: event.currentTarget.value })} rows={7} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }} />
        </section>
        <RefEditor
          title="Skills"
          refs={form.skillRefs}
          disabled={!editable}
          input={skillInput}
          suggestions={candidateAlternatives?.skills}
          onInputChange={setSkillInput}
          onAdd={() => addRef("skillRefs", skillInput)}
          onRemove={(ref) => removeRef("skillRefs", ref)}
        />
        <RefEditor
          title="MCP grants"
          refs={form.mcpGrantRefs}
          disabled={!editable}
          input={mcpInput}
          suggestions={candidateAlternatives?.mcpServers}
          onInputChange={setMcpInput}
          onAdd={() => addRef("mcpGrantRefs", mcpInput)}
          onRemove={(ref) => removeRef("mcpGrantRefs", ref)}
        />
        {profileOptions.length > 0 && (
          <section style={sectionStyle}>
            <div style={labelStyle}>Available profiles</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {profileOptions.map((profile) => (
                <div key={profile.id} style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                  {profile.id} {profile.model ? `/ ${profile.model}` : ""}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function RefEditor(props: {
  title: string;
  refs: string[];
  disabled: boolean;
  input: string;
  suggestions?: unknown;
  onInputChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (ref: string) => void;
}) {
  const suggestions = Array.isArray(props.suggestions) ? props.suggestions.map(readProfileOption).filter((item): item is ProfileOption => item !== null) : [];
  return (
    <section style={sectionStyle}>
      <div style={labelStyle}>{props.title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {props.refs.map((ref) => (
          <span key={ref} style={chipStyle}>
            {ref}
            <button type="button" disabled={props.disabled} onClick={() => props.onRemove(ref)} style={chipButtonStyle}>x</button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={props.input} disabled={props.disabled} onChange={(event) => props.onInputChange(event.currentTarget.value)} list={`${props.title}-suggestions`} style={inputStyle} />
        <button type="button" disabled={props.disabled || !props.input.trim()} onClick={props.onAdd} style={buttonStyle(props.disabled || !props.input.trim())}>Add</button>
      </div>
      <datalist id={`${props.title}-suggestions`}>
        {suggestions.map((item) => <option key={item.id} value={item.id} />)}
      </datalist>
    </section>
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readProfileOption(value: unknown): ProfileOption | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  if (!id) return null;
  const model = stringValue(record?.model);
  return {
    id,
    ...(model ? { model } : {}),
  };
}

const sectionStyle = { display: "flex", flexDirection: "column", gap: 8 } as const;
const labelStyle = { fontSize: 11, color: "var(--text-dim)", fontWeight: 650 } as const;
const inputStyle = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "7px 8px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
} as const;
const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: "1px solid var(--border)",
  borderRadius: 5,
  padding: "3px 5px 3px 7px",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  background: "var(--bg-panel)",
} as const;
const chipButtonStyle = {
  border: "none",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  padding: 0,
  fontSize: 11,
} as const;

function buttonStyle(disabled: boolean) {
  return {
    marginLeft: "auto",
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: disabled ? "var(--bg-panel)" : "var(--bg)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 11,
    padding: "5px 9px",
  } as const;
}
