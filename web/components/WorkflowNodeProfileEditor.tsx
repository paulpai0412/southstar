"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  buildNodeProfilePatchPayload,
  formEquals,
  normalizeNodeProfileForm,
  type WorkflowNodeProfileForm,
} from "@/lib/workflow/node-profile";
import { StructuredJsonEditor } from "./StructuredJsonEditor";
import { WorkflowNodeProfileRecommendations } from "./WorkflowNodeProfileRecommendations";
import { WorkflowNodeProfileSummary } from "./WorkflowNodeProfileSummary";

type RefField = "skillRefs" | "mcpGrantRefs" | "toolGrantRefs" | "vaultLeasePolicyRefs";

type CandidateOption = {
  id: string;
  model?: string;
  profileRefs?: string[];
};

type AgentProfileOption = CandidateOption & {
  harnessRef: string;
  provider: string;
  thinkingLevel: string;
  instruction: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
};

type PiModelOption = {
  id: string;
  name: string;
  provider: string;
};

const emptyForm: WorkflowNodeProfileForm = {
  harnessRef: "",
  provider: "",
  model: "",
  thinkingLevel: "",
  instruction: "",
  skillRefs: [],
  mcpGrantRefs: [],
  toolGrantRefs: [],
  vaultLeasePolicyRefs: [],
  nodePromptSpec: "",
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
  const [piModels, setPiModels] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedDefinitionRecord = recordValue(selectedDefinition);
  const candidateAlternatives = recordValue(recordValue(candidates)?.alternatives);
  const piModelRecord = recordValue(piModels);
  const piModelOptions = Array.isArray(piModelRecord?.modelList)
    ? piModelRecord.modelList.map(readPiModelOption).filter((model): model is PiModelOption => model !== null)
    : [];
  const piThinkingLevels = recordValue(piModelRecord?.thinkingLevels);
  const isPiHost = form.harnessRef === "pi";
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

  useEffect(() => {
    if (!isPiHost || piModels) return;
    void fetch("/api/models?")
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => setPiModels(payload))
      .catch(() => setPiModels({ modelList: [], thinkingLevels: {} }));
  }, [isPiHost, piModels]);

  const profileOptions = useMemo(() => {
    const list = candidateAlternatives?.agentProfiles;
    return Array.isArray(list) ? list.map(readAgentProfileOption).filter((profile): profile is AgentProfileOption => profile !== null) : [];
  }, [candidateAlternatives]);

  const harnessOptions = useMemo(() => uniqueOptionIds([
    form.harnessRef,
    ...profileOptions.map((profile) => profile.harnessRef),
    "pi",
    "codex",
  ]), [form.harnessRef, profileOptions]);

  const modelOptions = useMemo(() => uniqueOptionIds([
    form.model,
    ...profileOptions.map((profile) => profile.model ?? ""),
  ]), [form.model, profileOptions]);

  const providerOptions = useMemo(() => {
    if (!isPiHost) return ["pi", "codex", "claude-code", "openai", "anthropic", "custom"];
    return uniqueOptionIds([form.provider, ...piModelOptions.map((model) => model.provider)]);
  }, [form.provider, isPiHost, piModelOptions]);

  const selectedProviderPiModelOptions = useMemo(() => {
    const options = !isPiHost || !form.provider
      ? piModelOptions
      : piModelOptions.filter((model) => model.provider === form.provider);
    if (!isPiHost || !form.provider || !form.model || options.some((model) => model.id === form.model)) return options;
    return [
      { id: form.model, name: `${form.model} (current)`, provider: form.provider },
      ...options,
    ];
  }, [form.provider, isPiHost, piModelOptions]);

  const thinkingOptions = useMemo(() => {
    if (!isPiHost) return uniqueOptionIds([form.thinkingLevel, "none", "minimal", "low", "medium", "high", "xhigh"]);
    const key = `${form.provider}:${form.model}`;
    return uniqueOptionIds([form.thinkingLevel, ...stringArray(piThinkingLevels?.[key])]);
  }, [form.model, form.provider, form.thinkingLevel, isPiHost, piThinkingLevels]);

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
      setNotice("Saved. Revalidate this draft before creating a run.");
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

  const applyProfileCandidate = (profileId: string) => {
    const profile = profileOptions.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    update({
      harnessRef: profile.harnessRef,
      provider: profile.provider,
      model: profile.model ?? "",
      thinkingLevel: profile.thinkingLevel,
      instruction: profile.instruction,
      skillRefs: profile.skillRefs,
      mcpGrantRefs: profile.mcpGrantRefs,
      toolGrantRefs: profile.toolGrantRefs,
      vaultLeasePolicyRefs: profile.vaultLeasePolicyRefs,
    });
  };

  const addRefs = (field: RefField, values: string[]) => {
    const refs = values.map((value) => value.trim()).filter(Boolean);
    if (refs.length === 0) return;
    setForm((current) => ({ ...current, [field]: [...new Set([...current[field], ...refs])] }));
  };

  const removeRef = (field: RefField, value: string) => {
    setForm((current) => ({ ...current, [field]: current[field].filter((item) => item !== value) }));
  };

  if (loading) {
    return <div data-testid="workflow-node-profile-editor" style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;
  }

  return (
    <div data-testid="workflow-node-profile-editor" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={toolbarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={taskTitleStyle}>
            {stringValue(selectedDefinitionRecord?.taskName) || taskId}
          </div>
          <div style={taskMetaStyle}>
            {mode} / {taskId}
          </div>
        </div>
        <button data-testid="workflow-node-profile-reset" onClick={() => setForm(serverForm)} disabled={!dirty || saving} style={buttonStyle(!dirty || saving)}>
          Reset
        </button>
        <button data-testid="workflow-node-profile-save" onClick={() => void save()} disabled={!dirty || !editable || saving} style={primaryButtonStyle(!dirty || !editable || saving)}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      <div style={bodyStyle}>
        {!editable && (
          <div style={noticeStyle}>
            Runtime profile is locked to the launched run. Edit the Workflow draft before creating a future run.
          </div>
        )}
        {error && <div style={errorStyle}>{error}</div>}
        {notice && <div style={successStyle}>{notice}</div>}

        <WorkflowNodeProfileSummary
          taskId={taskId}
          mode={mode}
          selectedDefinition={selectedDefinition}
          form={form}
          editable={editable}
          dirty={dirty}
        />

        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>Candidate profile</h2>
            <span style={sectionMetaStyle}>{profileOptions.length} profiles</span>
          </div>
          <select
            data-testid="workflow-profile-candidate-profile"
            value=""
            disabled={!editable || profileOptions.length === 0}
            onChange={(event) => applyProfileCandidate(event.currentTarget.value)}
            style={inputStyle}
          >
            <option value="">Apply profile candidate...</option>
            {profileOptions.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.id}{profile.model ? ` / ${profile.model}` : ""}
              </option>
            ))}
          </select>
        </section>

        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>Host and model</h2>
            <span style={sectionMetaStyle}>adapter / provider / thinking</span>
          </div>
          <div style={twoColumnGridStyle}>
            <Field label="Host adapter">
              <select
                data-testid="workflow-profile-host-adapter"
                value={form.harnessRef}
                disabled={!editable}
                onChange={(event) => update({ harnessRef: event.currentTarget.value })}
                style={inputStyle}
              >
                <option value="">Default</option>
                {harnessOptions.map((harness) => <option key={harness} value={harness}>{harness}</option>)}
              </select>
            </Field>
            <Field label="Provider">
              <select
                data-testid="workflow-profile-provider"
                value={form.provider}
                disabled={!editable}
                onChange={(event) => update({ provider: event.currentTarget.value, model: "", thinkingLevel: "" })}
                style={inputStyle}
              >
                <option value="">Default</option>
                {providerOptions.map((provider) => (
                  <option key={provider} value={provider}>{provider}</option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              {isPiHost ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <select
                    data-testid="workflow-profile-model"
                    value={form.model}
                    disabled={!editable}
                    onChange={(event) => update({ model: event.currentTarget.value, thinkingLevel: "" })}
                    style={inputStyle}
                  >
                    <option value="">Default</option>
                    {selectedProviderPiModelOptions.map((model) => (
                      <option key={`${model.provider}:${model.id}`} value={model.id}>
                        {model.name || model.id}
                      </option>
                    ))}
                  </select>
                  <input
                    data-testid="workflow-profile-model-custom"
                    value={form.model}
                    disabled={!editable || !form.provider}
                    onChange={(event) => update({ model: event.currentTarget.value, thinkingLevel: "" })}
                    placeholder="Custom model id"
                    style={inputStyle}
                  />
                </div>
              ) : (
                <>
                  <input
                    data-testid="workflow-profile-model"
                    value={form.model}
                    disabled={!editable}
                    onChange={(event) => update({ model: event.currentTarget.value })}
                    list="workflow-profile-model-options"
                    style={inputStyle}
                  />
                  <datalist id="workflow-profile-model-options">
                    {modelOptions.map((model) => <option key={model} value={model} />)}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Thinking mode">
              <select
                data-testid="workflow-profile-thinking-mode"
                value={form.thinkingLevel}
                disabled={!editable}
                onChange={(event) => update({ thinkingLevel: event.currentTarget.value })}
                style={inputStyle}
              >
                <option value="">Default</option>
                {thinkingOptions.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        <RefEditor
          title="Skills"
          field="skillRefs"
          refs={form.skillRefs}
          disabled={!editable}
          suggestions={candidateAlternatives?.skills}
          onAdd={(refs) => addRefs("skillRefs", refs)}
          onRemove={(ref) => removeRef("skillRefs", ref)}
        />
        <RefEditor
          title="MCP grants"
          field="mcpGrantRefs"
          refs={form.mcpGrantRefs}
          disabled={!editable}
          suggestions={candidateAlternatives?.mcpServers}
          onAdd={(refs) => addRefs("mcpGrantRefs", refs)}
          onRemove={(ref) => removeRef("mcpGrantRefs", ref)}
        />
        <RefEditor
          title="Tools"
          field="toolGrantRefs"
          refs={form.toolGrantRefs}
          disabled={!editable}
          suggestions={candidateAlternatives?.tools}
          onAdd={(refs) => addRefs("toolGrantRefs", refs)}
          onRemove={(ref) => removeRef("toolGrantRefs", ref)}
        />
        <RefEditor
          title="Vault leases"
          field="vaultLeasePolicyRefs"
          refs={form.vaultLeasePolicyRefs}
          disabled={!editable}
          suggestions={candidateAlternatives?.vaultLeasePolicies}
          onAdd={(refs) => addRefs("vaultLeasePolicyRefs", refs)}
          onRemove={(ref) => removeRef("vaultLeasePolicyRefs", ref)}
        />

        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>Original prompt</h2>
            <span style={sectionMetaStyle}>nodePromptSpec JSON</span>
          </div>
          <div data-testid="workflow-profile-prompt" style={jsonEditorFrameStyle}>
            <StructuredJsonEditor
              value={form.nodePromptSpec}
              onChange={(nodePromptSpec) => update({ nodePromptSpec })}
              readOnly={!editable}
            />
          </div>
        </section>

        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>Profile instruction</h2>
            <span style={sectionMetaStyle}>worker system guidance</span>
          </div>
          <textarea
            value={form.instruction}
            disabled={!editable}
            onChange={(event) => update({ instruction: event.currentTarget.value })}
            rows={7}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }}
          />
        </section>

        <section data-testid="workflow-profile-agents-md" style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>AGENTS.md</h2>
            <span style={sectionMetaStyle}>generated worker instructions</span>
          </div>
          <div style={agentsMdNoteStyle}>
            Runtime AGENTS.md is generated from Profile instruction, nodePromptSpec, selected skills, MCP grants, tools, and vault leases. Edit those source fields here before launching the run.
          </div>
        </section>

        <WorkflowNodeProfileRecommendations
          candidates={candidates}
          selectedDefinition={selectedDefinition}
          editable={editable}
        />
      </div>
    </div>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{props.label}</span>
      {props.children}
    </label>
  );
}

function RefEditor(props: {
  title: string;
  field: RefField;
  refs: string[];
  disabled: boolean;
  suggestions?: unknown;
  onAdd: (refs: string[]) => void;
  onRemove: (ref: string) => void;
}) {
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const suggestions = useMemo(
    () => Array.isArray(props.suggestions) ? props.suggestions.map(readCandidateOption).filter((item): item is CandidateOption => item !== null) : [],
    [props.suggestions]
  );
  const candidateIds = useMemo(
    () => uniqueOptionIds(suggestions.map((item) => item.id).filter((id) => !props.refs.includes(id))),
    [props.refs, suggestions]
  );
  useEffect(() => {
    setSelectedCandidates((current) => current.filter((id) => candidateIds.includes(id)));
  }, [candidateIds]);
  const addDisabled = props.disabled || selectedCandidates.length === 0;
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{props.title}</h2>
        <span style={sectionMetaStyle}>{props.refs.length} selected / {candidateIds.length} candidates</span>
      </div>
      <div style={chipRowStyle}>
        {props.refs.length === 0 && <span style={emptyChipStyle}>none</span>}
        {props.refs.map((ref) => (
          <span key={ref} style={chipStyle}>
            {ref}
            <button type="button" disabled={props.disabled} onClick={() => props.onRemove(ref)} style={chipButtonStyle}>x</button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <select
          data-testid={`workflow-profile-candidate-select-${props.field}`}
          multiple
          value={selectedCandidates}
          disabled={props.disabled || candidateIds.length === 0}
          onChange={(event) => {
            const values = Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
            setSelectedCandidates(values);
          }}
          size={Math.min(Math.max(candidateIds.length, 3), 8)}
          style={candidateSelectStyle}
        >
          {candidateIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <button type="button" disabled={addDisabled} onClick={() => { props.onAdd(selectedCandidates); setSelectedCandidates([]); }} style={buttonStyle(addDisabled)}>Add selected</button>
      </div>
    </section>
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readCandidateOption(value: unknown): CandidateOption | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  if (!id) return null;
  const model = stringValue(record?.model);
  const profileRefs = stringArray(record?.profileRefs);
  return {
    id,
    ...(model ? { model } : {}),
    ...(profileRefs.length > 0 ? { profileRefs } : {}),
  };
}

function readPiModelOption(value: unknown): PiModelOption | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const provider = stringValue(record?.provider);
  if (!id || !provider) return null;
  return { id, provider, name: stringValue(record?.name) || id };
}

function readAgentProfileOption(value: unknown): AgentProfileOption | null {
  const record = recordValue(value);
  const option = readCandidateOption(value);
  if (!record || !option) return null;
  const toolPolicy = recordValue(record.toolPolicy);
  return {
    ...option,
    harnessRef: stringValue(record.harnessRef),
    provider: stringValue(record.provider),
    thinkingLevel: stringValue(record.thinkingLevel),
    instruction: stringValue(record.instruction),
    skillRefs: stringArray(record.skillRefs),
    mcpGrantRefs: stringArray(record.mcpGrantRefs),
    toolGrantRefs: stringArray(record.toolGrantRefs ?? toolPolicy?.allowedTools),
    vaultLeasePolicyRefs: stringArray(record.vaultLeasePolicyRefs),
  };
}

function uniqueOptionIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

const toolbarStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 10px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-panel)",
} as const;

const taskTitleStyle = {
  fontSize: 12,
  fontWeight: 650,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const taskMetaStyle = {
  fontSize: 11,
  color: "var(--text-dim)",
  fontFamily: "var(--font-mono)",
} as const;

const bodyStyle = {
  flex: 1,
  overflow: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 12,
} as const;

const sectionStyle = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;

const sectionHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} as const;

const sectionTitleStyle = {
  margin: 0,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 650,
} as const;

const sectionMetaStyle = {
  color: "var(--text-dim)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
} as const;

const fieldStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  minWidth: 0,
} as const;

const labelStyle = { fontSize: 11, color: "var(--text-dim)", fontWeight: 650 } as const;

const twoColumnGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
} as const;

const inputStyle = {
  width: "100%",
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg-panel)",
  color: "var(--text)",
  padding: "7px 8px",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
} as const;

const jsonEditorFrameStyle = {
  minHeight: 260,
  border: "1px solid var(--border)",
  borderRadius: 5,
  overflow: "hidden",
  background: "var(--bg-panel)",
} as const;

const agentsMdNoteStyle = {
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 12,
  lineHeight: 1.45,
  padding: 10,
} as const;

const chipRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
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
  maxWidth: "100%",
  overflowWrap: "anywhere",
} as const;

const emptyChipStyle = {
  fontSize: 11,
  color: "var(--text-dim)",
  fontFamily: "var(--font-mono)",
} as const;

const chipButtonStyle = {
  border: "none",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  padding: 0,
  fontSize: 11,
} as const;

const noticeStyle = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 10,
  color: "var(--text-muted)",
  fontSize: 12,
  background: "var(--bg-panel)",
} as const;

const errorStyle = { color: "#ef4444", fontSize: 12 } as const;
const successStyle = { color: "var(--accent)", fontSize: 12 } as const;

function buttonStyle(disabled: boolean) {
  return {
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: disabled ? "var(--bg-panel)" : "var(--bg)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 11,
    padding: "5px 9px",
  } as const;
}

function primaryButtonStyle(disabled: boolean) {
  return {
    ...buttonStyle(disabled),
    background: disabled ? "var(--bg-panel)" : "var(--accent)",
    color: disabled ? "var(--text-dim)" : "white",
    borderColor: disabled ? "var(--border)" : "var(--accent)",
  } as const;
}

const candidateSelectStyle = {
  ...inputStyle,
  flex: "1 1 auto",
  minHeight: 84,
  padding: 6,
} as const;
