"use client";

import { AlertCircle, FileText, Mic2, PencilLine, Play, Send, Sparkles, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import type { PlannerDraftView, RunCreationView } from "./types";

export function PlannerChat(props: {
  busyAction: string | null;
  draft: PlannerDraftView | null;
  error: string | null;
  goalPrompt: string;
  run: RunCreationView | null;
  onCreateDraft: () => void;
  onGoalPromptChange: (goalPrompt: string) => void;
  onReviewDraft?: () => void;
  onRevise?: () => void;
  onRunDraft: () => void;
}) {
  const { busyAction, draft, error, goalPrompt, run, onCreateDraft, onGoalPromptChange, onReviewDraft, onRevise, onRunDraft } = props;
  return (
    <section className="ss-panel ss-planner" data-panel="planner-chat" id="planner-chat">
      <header className="ss-planner-header">
        <div>
          <h2><Sparkles size={15} aria-hidden /> Planner Chat</h2>
          <p>Prompt to dynamic workflow</p>
        </div>
        <select aria-label="input mode" defaultValue="goal">
          <option value="goal">Goal Prompt</option>
          <option value="steering">Steering</option>
          <option value="voice">Voice Transcript</option>
        </select>
      </header>
      <div className="ss-planner-status-grid" aria-label="planner gate status">
        <StatusTile tone={draft ? "ready" : "idle"} icon={<FileText size={15} aria-hidden />} label="Draft Plan" value={draft ? "Ready" : "Waiting"} title="Dynamic workflow draft generated from the current prompt." />
        <StatusTile tone={run ? "active" : "idle"} icon={<Workflow size={15} aria-hidden />} label="Run State" value={run ? "Queued" : "Not started"} title="Runtime execution state after a draft is submitted." />
        <StatusTile tone={error ? "risk" : "ready"} icon={<Mic2 size={15} aria-hidden />} label="Voice Gate" value={error ? "Check" : "Auto gate"} title="Low-risk voice or steering command gate for the current run." />
      </div>
      <textarea
        aria-label="planner input"
        value={goalPrompt}
        onChange={(event) => onGoalPromptChange(event.currentTarget.value)}
      />
      <div className="ss-actions">
        <button type="button" onClick={onCreateDraft} disabled={busyAction !== null}>
          <Send size={14} aria-hidden /> {busyAction === "planner" ? "Planning..." : "Send to Planner"}
        </button>
        <button type="button" onClick={onReviewDraft} disabled={!draft}><FileText size={14} aria-hidden /> Review Draft</button>
        <button type="button" onClick={onRevise} disabled={!draft || busyAction !== null}><PencilLine size={14} aria-hidden /> Revise</button>
        <button type="button" onClick={onRunDraft} disabled={busyAction !== null}>
          <Play size={14} aria-hidden /> {busyAction === "run" ? "Starting..." : "Run"}
        </button>
      </div>
      <ol className="ss-timeline">
        <li>
          <strong className={draft ? "ss-chip-ready" : "ss-chip-idle"}>{draft ? "draft" : "idle"}</strong>
          <span>{draft ? `Dynamic Workflow ${draft.workflowId}` : "Waiting for goal prompt"}</span>
        </li>
        <li>
          <strong className={run ? "ss-chip-active" : "ss-chip-info"}>{run ? "run" : "voice"}</strong>
          <span>{run ? `Run ${run.runId} · Tork job ${run.tork?.jobId ?? "queued"}` : "Voice Transcript: low-risk steering auto approved"}</span>
        </li>
        {error ? (
          <li>
            <strong className="ss-chip-risk"><AlertCircle size={12} aria-hidden /> error</strong>
            <span>{error}</span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

function StatusTile(props: { tone: "active" | "ready" | "risk" | "idle"; icon: ReactNode; label: string; value: string; title: string }) {
  return (
    <div className={`ss-planner-status-tile ss-tone-${props.tone}`} title={props.title}>
      <span>{props.icon}</span>
      <small>{props.label}</small>
      <strong>{props.value}</strong>
    </div>
  );
}
