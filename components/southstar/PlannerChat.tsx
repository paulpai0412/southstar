"use client";

import type { PlannerDraftView, RunCreationView } from "./types";

export function PlannerChat(props: {
  busyAction: string | null;
  draft: PlannerDraftView | null;
  error: string | null;
  goalPrompt: string;
  run: RunCreationView | null;
  onCreateDraft: () => void;
  onGoalPromptChange: (goalPrompt: string) => void;
  onRunDraft: () => void;
}) {
  const { busyAction, draft, error, goalPrompt, run, onCreateDraft, onGoalPromptChange, onRunDraft } = props;
  return (
    <section className="ss-panel ss-planner" data-panel="planner-chat" id="planner-chat">
      <header>
        <h2>Planner Chat</h2>
        <select aria-label="input mode" defaultValue="goal">
          <option value="goal">Goal Prompt</option>
          <option value="steering">Steering</option>
          <option value="voice">Voice Transcript</option>
        </select>
      </header>
      <textarea
        aria-label="planner input"
        value={goalPrompt}
        onChange={(event) => onGoalPromptChange(event.currentTarget.value)}
      />
      <div className="ss-actions">
        <button type="button" onClick={onCreateDraft} disabled={busyAction !== null}>
          {busyAction === "planner" ? "Planning..." : "Send to Planner"}
        </button>
        <button type="button" disabled={!draft}>Review Draft</button>
        <button type="button" disabled={!draft || busyAction !== null}>Revise</button>
        <button type="button" onClick={onRunDraft} disabled={busyAction !== null}>
          {busyAction === "run" ? "Starting..." : "Run"}
        </button>
      </div>
      <ol className="ss-timeline">
        <li>
          <strong>{draft ? "draft" : "idle"}</strong>
          <span>{draft ? `Dynamic Workflow ${draft.workflowId}` : "Waiting for goal prompt"}</span>
        </li>
        <li>
          <strong>{run ? "run" : "voice"}</strong>
          <span>{run ? `Run ${run.runId} · Tork job ${run.tork?.jobId ?? "queued"}` : "Voice Transcript: low-risk steering auto approved"}</span>
        </li>
        {error ? (
          <li>
            <strong>error</strong>
            <span>{error}</span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
