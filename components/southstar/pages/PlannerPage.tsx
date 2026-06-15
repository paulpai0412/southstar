"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { Button } from "../ui/Button";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function PlannerPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [goalPrompt, setGoalPrompt] = useState("");
  const [model, setModel] = useState<any | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  async function refresh(nextDraftId = draftId) { setModel(await api.getUiPlanner(nextDraftId ?? undefined)); }
  useEffect(() => { void refresh(); }, []);
  async function sendToPlanner() {
    const draft = await api.createDraft(goalPrompt);
    setDraftId(draft.draftId);
    await refresh(draft.draftId);
  }
  async function runNow() {
    if (!draftId) return;
    const run = await api.runDraft(draftId);
    window.location.href = `/runtime?runId=${encodeURIComponent(run.runId)}`;
  }
  return (
    <SouthstarShell title="Planner Chat">
      <div className="ss-page-grid ss-planner-page">
        <Panel title="Goal Prompt">
          <div className="ss-tabs"><button>Goal Prompt</button><button>Steering</button><button>Voice Transcript</button></div>
          <textarea aria-label="planner input" value={goalPrompt} onChange={(event) => setGoalPrompt(event.currentTarget.value)} />
          <div className="ss-actions"><Button type="button" onClick={sendToPlanner}>Send to Planner</Button><Button type="button">Review Draft</Button><Button type="button" onClick={runNow}>Run Now</Button></div>
        </Panel>
        <Panel title="Dynamic Workflow Draft">
          <p>{model?.activeDraft ? `${model.activeDraft.taskCount} tasks generated` : "No draft selected"}</p>
          <h3>Task Assignment</h3>
          <table><tbody>{model?.taskAssignments?.map((row: any) => <tr key={row.task}><td>{row.task}</td><td>{row.role}</td><td>{row.agent}</td><td>{row.model}</td></tr>)}</tbody></table>
        </Panel>
        <Panel title="Run Readiness">
          {model?.readiness?.map((row: any) => <p key={row.label}>{row.label}: {row.value}</p>)}
          <h3>Context Budget Preview</h3><p>{model?.contextBudget?.totalTokens ?? 0} / {model?.contextBudget?.limitTokens ?? 128000}</p>
          <h3>Artifact Contract</h3>{model?.artifactContract?.map((row: any) => <p key={row.label}>{row.label}</p>)}
          <h3>Stop Condition</h3>{model?.stopCondition?.map((row: any) => <p key={row.label}>{row.label}</p>)}
        </Panel>
      </div>
    </SouthstarShell>
  );
}
