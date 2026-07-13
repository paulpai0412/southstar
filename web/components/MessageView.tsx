"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { WorkflowDagBlock } from "./WorkflowDagBlock";
import { GoalSlicePlanBlock } from "./GoalSlicePlanBlock";
import { GoalRequirementListBlock, type GoalRequirementsConfirmation } from "./GoalRequirementListBlock";
import { LibraryCandidateMessageBlock } from "./library/LibraryCandidateMessageBlock";
import { LibraryGraphBlock } from "./library/LibraryGraphBlock";
import type { LibraryGraphChartNode } from "./library/LibraryGraphChart";
import { runLibraryCandidateInstallCommand } from "@/lib/library/chat-stream";
import type { LibraryImportCandidate, LibraryImportProposedEdge, LibrarySseFrame } from "@/lib/library/types";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  WorkflowDagContent,
  GoalDesignContent,
  GoalRequirementsContent,
  GoalSliceSelection,
  GoalRequirementSelection,
  LibraryGraphContent,
  LibraryImportCandidatesContent,
  WorkflowDagCustomDetails,
  WorkspaceSurface,
} from "@/lib/types";
import { buildWorkflowDagFromPlannerDraft, type V2PlannerDraftOrchestrationView } from "@/lib/workflow/v2-library-adapter";
import type { WorkflowDag, WorkflowDagNode } from "@/lib/workflow/types";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  workflowCwd?: string | null;
  onWorkflowDagNodeSelect?: (node: WorkflowDagNode) => void;
  onGoalSliceSelect?: (selection: GoalSliceSelection) => void;
  onConfirmGoalDesign?: (selection: GoalSliceSelection) => void;
  onGoalRequirementSelect?: (selection: GoalRequirementSelection) => void;
  onConfirmRequirements?: (confirmation: GoalRequirementsConfirmation) => void | Promise<GoalRequirementsContent | void>;
  onGoalContractSelect?: (dag: WorkflowDag) => void;
  onWorkflowGoalRevise?: (dag: WorkflowDag, choice?: string) => void;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export function MessageView({ message, isStreaming, toolResults, modelNames, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, workflowCwd, onWorkflowDagNodeSelect, onGoalSliceSelect, onConfirmGoalDesign, onGoalRequirementSelect, onConfirmRequirements, onGoalContractSelect, onWorkflowGoalRevise, onLibraryGraphNodeSelect, onWorkspaceSurfaceChange }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} workflowCwd={workflowCwd} onWorkflowDagNodeSelect={onWorkflowDagNodeSelect} onGoalSliceSelect={onGoalSliceSelect} onConfirmGoalDesign={onConfirmGoalDesign} onGoalRequirementSelect={onGoalRequirementSelect} onConfirmRequirements={onConfirmRequirements} onGoalContractSelect={onGoalContractSelect} onWorkflowGoalRevise={onWorkflowGoalRevise} onLibraryGraphNodeSelect={onLibraryGraphNodeSelect} onWorkspaceSurfaceChange={onWorkspaceSurfaceChange} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    return <CustomMessageView message={message as CustomMessage} workflowCwd={workflowCwd} onWorkflowDagNodeSelect={onWorkflowDagNodeSelect} onGoalContractSelect={onGoalContractSelect} onWorkflowGoalRevise={onWorkflowGoalRevise} />;
  }
  return null;
}

function UserMessageView({ message, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {
  message: UserMessage;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  const copyContent = () => {
    copyText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid rgba(59,130,246,0.2)",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid rgba(59,130,246,0.15)" }}
                  />
                );
              })}
            </div>
          )}
          {content && <MarkdownBody className="markdown-user-message">{content}</MarkdownBody>}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canNavigate || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 3,
        }}>
          <div style={{
            display: "flex", gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}>
            <button
              onClick={copyContent}
              title="Copy message"
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 8px", height: 22,
                background: "none", border: "none",
                borderRadius: 5,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11, fontWeight: 400,
                whiteSpace: "nowrap",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {(canFork || canNavigate) && (
            <div style={{
              display: "flex", gap: 3,
              opacity: (hovered || forking) ? 1 : 0,
              pointerEvents: (hovered || forking) ? "auto" : "none",
              transition: "opacity 0.12s",
            }}>
              {canNavigate && (
                <button
                  onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(content); }}
                  title="Edit from here — branches within this session"
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                  Edit from here
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                  title={forking ? "Creating new session…" : "New session — creates an independent copy from here"}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", height: 22,
                    background: "none", border: "none",
                    borderRadius: 5,
                    color: forking ? "var(--accent)" : "var(--text-dim)",
                    cursor: forking ? "not-allowed" : "pointer",
                    fontSize: 11, fontWeight: 400,
                    whiteSpace: "nowrap",
                    transition: "color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  {forking ? "Creating…" : "New session"}
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  showTimestamp,
  prevTimestamp,
  workflowCwd,
  onWorkflowDagNodeSelect,
  onGoalSliceSelect,
  onConfirmGoalDesign,
  onGoalRequirementSelect,
  onConfirmRequirements,
  onGoalContractSelect,
  onWorkflowGoalRevise,
  onLibraryGraphNodeSelect,
  onWorkspaceSurfaceChange,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  workflowCwd?: string | null;
  onWorkflowDagNodeSelect?: (node: WorkflowDagNode) => void;
  onGoalSliceSelect?: (selection: GoalSliceSelection) => void;
  onConfirmGoalDesign?: (selection: GoalSliceSelection) => void;
  onGoalRequirementSelect?: (selection: GoalRequirementSelection) => void;
  onConfirmRequirements?: (confirmation: GoalRequirementsConfirmation) => void | Promise<GoalRequirementsContent | void>;
  onGoalContractSelect?: (dag: WorkflowDag) => void;
  onWorkflowGoalRevise?: (dag: WorkflowDag, choice?: string) => void;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
}) {
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blocks = message.content ?? [];
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = Date.now();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const bs = blocksRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      bs.forEach((_, i) => {
        if (!blockStartTimesRef.current.has(i)) blockStartTimesRef.current.set(i, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < bs.length - 1; i++) {
          if (!next.has(i) && blockStartTimesRef.current.has(i)) {
            const start = blockStartTimesRef.current.get(i)!;
            const nextStart = blockStartTimesRef.current.get(i + 1) ?? now;
            next.set(i, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  return (
    <div
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title="预估 token 数（流式接收中）">
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(i) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} workflowCwd={workflowCwd} onWorkflowDagNodeSelect={onWorkflowDagNodeSelect} onGoalSliceSelect={onGoalSliceSelect} onConfirmGoalDesign={onConfirmGoalDesign} onGoalRequirementSelect={onGoalRequirementSelect} onConfirmRequirements={onConfirmRequirements} onGoalContractSelect={onGoalContractSelect} onWorkflowGoalRevise={onWorkflowGoalRevise} onLibraryGraphNodeSelect={onLibraryGraphNodeSelect} onWorkspaceSurfaceChange={onWorkspaceSurfaceChange} />
        ))}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage)}
          </div>
        )}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            title="Copy message"
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, workflowCwd, onWorkflowDagNodeSelect, onGoalSliceSelect, onConfirmGoalDesign, onGoalRequirementSelect, onConfirmRequirements, onGoalContractSelect, onWorkflowGoalRevise, onLibraryGraphNodeSelect, onWorkspaceSurfaceChange }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; workflowCwd?: string | null; onWorkflowDagNodeSelect?: (node: WorkflowDagNode) => void; onGoalSliceSelect?: (selection: GoalSliceSelection) => void; onConfirmGoalDesign?: (selection: GoalSliceSelection) => void; onGoalRequirementSelect?: (selection: GoalRequirementSelection) => void; onConfirmRequirements?: (confirmation: GoalRequirementsConfirmation) => void | Promise<GoalRequirementsContent | void>; onGoalContractSelect?: (dag: WorkflowDag) => void; onWorkflowGoalRevise?: (dag: WorkflowDag, choice?: string) => void; onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void; onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} />;
  }
  if (block.type === "workflowDag") {
    return <WorkflowDagBlock dag={(block as WorkflowDagContent).dag} cwd={workflowCwd} onNodeSelect={onWorkflowDagNodeSelect} onGoalContractSelect={onGoalContractSelect} onReviseGoal={onWorkflowGoalRevise} />;
  }
  if (block.type === "goalDesign") {
    return <GoalSlicePlanBlock block={block as GoalDesignContent} onSliceSelect={onGoalSliceSelect} onConfirmGoalDesign={onConfirmGoalDesign} />;
  }
  if (block.type === "goalRequirements") {
    return <GoalRequirementListBlock block={block as GoalRequirementsContent} onRequirementSelect={onGoalRequirementSelect} onConfirmRequirements={onConfirmRequirements} />;
  }
  if (block.type === "libraryGraph") {
    const libraryGraph = block as LibraryGraphContent;
    return <LibraryGraphBlock data={libraryGraph.data} defaultScope={libraryGraph.defaultScope ?? "all"} onSelectNode={onLibraryGraphNodeSelect} />;
  }
  if (block.type === "libraryImportCandidates") {
    const candidates = block as LibraryImportCandidatesContent;
    return <ChatLibraryCandidateBlock data={{ draftId: candidates.draftId, candidates: candidates.candidates, proposedEdges: candidates.proposedEdges }} onSelectNode={onLibraryGraphNodeSelect} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} workflowCwd={workflowCwd} onWorkflowDagNodeSelect={onWorkflowDagNodeSelect} onGoalContractSelect={onGoalContractSelect} onWorkflowGoalRevise={onWorkflowGoalRevise} onLibraryGraphNodeSelect={onLibraryGraphNodeSelect} onWorkspaceSurfaceChange={onWorkspaceSurfaceChange} />;
  }
  return null;
}

function TextBlock({ block, isStreaming }: { block: TextContent; isStreaming?: boolean }) {
  return <MarkdownBody isStreaming={isStreaming}>{block.text}</MarkdownBody>;
}

function ThinkingBlock({ block, duration }: { block: ThinkingContent; duration?: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span>Thinking</span>
        {duration !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {block.thinking}
        </div>
      )}
    </div>
  );
}


function ToolCallBlock({
  block,
  result,
  duration,
  workflowCwd,
  onWorkflowDagNodeSelect,
  onGoalContractSelect,
  onWorkflowGoalRevise,
  onLibraryGraphNodeSelect,
  onWorkspaceSurfaceChange,
}: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
  workflowCwd?: string | null;
  onWorkflowDagNodeSelect?: (node: WorkflowDagNode) => void;
  onGoalContractSelect?: (dag: WorkflowDag) => void;
  onWorkflowGoalRevise?: (dag: WorkflowDag, choice?: string) => void;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);
  const southstarBlock = result ? (
    <SouthstarToolResultBlock
      toolCall={block}
      result={result}
      workflowCwd={workflowCwd}
      onWorkflowDagNodeSelect={onWorkflowDagNodeSelect}
      onGoalContractSelect={onGoalContractSelect}
      onWorkflowGoalRevise={onWorkflowGoalRevise}
      onLibraryGraphNodeSelect={onLibraryGraphNodeSelect}
      onWorkspaceSurfaceChange={onWorkspaceSurfaceChange}
    />
  ) : null;

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
          {block.toolName}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {getToolPreview(block)}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {southstarBlock}

      {/* ── Expanded: input args ── */}
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}
    </div>
  );
}

function SouthstarToolResultBlock({
  toolCall,
  result,
  workflowCwd,
  onWorkflowDagNodeSelect,
  onGoalContractSelect,
  onWorkflowGoalRevise,
  onLibraryGraphNodeSelect,
  onWorkspaceSurfaceChange,
}: {
  toolCall: ToolCallContent;
  result: ToolResultMessage;
  workflowCwd?: string | null;
  onWorkflowDagNodeSelect?: (node: WorkflowDagNode) => void;
  onGoalContractSelect?: (dag: WorkflowDag) => void;
  onWorkflowGoalRevise?: (dag: WorkflowDag, choice?: string) => void;
  onLibraryGraphNodeSelect?: (node: LibraryGraphChartNode) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
}) {
  const details = readSouthstarToolDetails(result.details);
  const mcpToolName = details?.mcpToolName;
  const piToolName = details?.piToolName ?? result.toolName ?? toolCall.toolName;
  const payload = unwrapStructuredContent(details?.structuredContent);
  const inferredSurface = inferSouthstarWorkspaceSurface(mcpToolName, piToolName);
  const reportedSurfaceRef = useRef<WorkspaceSurface | null>(null);

  useEffect(() => {
    if (!inferredSurface || reportedSurfaceRef.current === inferredSurface) return;
    reportedSurfaceRef.current = inferredSurface;
    onWorkspaceSurfaceChange?.(inferredSurface);
  }, [inferredSurface, onWorkspaceSurfaceChange]);

  if (isLibraryGraphTool(mcpToolName, piToolName) && isLibraryGraphPayload(payload)) {
    return (
      <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", padding: 10 }}>
        <LibraryGraphBlock data={payload} defaultScope={typeof payload.activeScope === "string" ? payload.activeScope : "all"} onSelectNode={onLibraryGraphNodeSelect} />
      </div>
    );
  }

  if (isLibraryImportTool(mcpToolName, piToolName) && isLibraryImportCandidatePayload(payload)) {
    return (
      <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", padding: 10 }}>
        <ChatLibraryCandidateBlock data={payload} onSelectNode={onLibraryGraphNodeSelect} />
      </div>
    );
  }

  const workflowDag = workflowDagFromSouthstarToolResult(mcpToolName, piToolName, payload);
  if (workflowDag) {
    return (
      <div style={{ borderTop: "1px solid rgba(34,197,94,0.15)", padding: 10 }}>
        <WorkflowDagBlock dag={workflowDag} cwd={workflowCwd} onNodeSelect={onWorkflowDagNodeSelect} onGoalContractSelect={onGoalContractSelect} onReviseGoal={onWorkflowGoalRevise} />
      </div>
    );
  }

  return null;
}

function ChatLibraryCandidateBlock({ data, onSelectNode }: { data: LibraryImportCandidatePayload; onSelectNode?: (node: LibraryGraphChartNode) => void }) {
  const [status, setStatus] = useState<"draft" | "installing" | "installed">("draft");
  const [installedObjectKeys, setInstalledObjectKeys] = useState<string[]>([]);
  const [installFrames, setInstallFrames] = useState<LibrarySseFrame[]>([]);
  const [installedGraph, setInstalledGraph] = useState<LibraryGraphPayload | null>(null);

  const installCandidates = async (selectedCandidateIds: string[]) => {
    setStatus("installing");
    setInstallFrames([]);
    setInstalledGraph(null);
    let sawStreamError = false;
    try {
      await runLibraryCandidateInstallCommand({
        draftId: data.draftId,
        selectedCandidateIds,
        actor: "pi-agent",
        reason: "Installed from Southstar chat tool result.",
        onFrame(frame) {
          if (frame.event === "library.error") sawStreamError = true;
          setInstallFrames((current) => [...current, frame]);
          if ((frame.event === "library.graph.snapshot" || frame.event === "library.ontology.graph") && isLibraryGraphPayload(frame.data)) {
            setInstalledGraph(frame.data);
          }
          if (frame.event === "library.command.completed" || frame.event === "library.db.synced") {
            setStatus("installed");
            setInstalledObjectKeys(selectedCandidateIds);
          }
        },
      });
      setStatus("installed");
      setInstalledObjectKeys(selectedCandidateIds);
    } catch (error) {
      setStatus("draft");
      if (!sawStreamError) {
        setInstallFrames((current) => [...current, {
          event: "library.error",
          data: { message: error instanceof Error ? error.message : String(error) },
        }]);
      }
    }
  };

  return (
    <>
      <LibraryCandidateMessageBlock
        draftId={data.draftId}
        candidates={data.candidates}
        proposedEdges={data.proposedEdges}
        status={status}
        installedObjectKeys={installedObjectKeys}
        onInstall={(selectedCandidateIds) => void installCandidates(selectedCandidateIds)}
      />
      <LibraryInstallFrames frames={installFrames} />
      {installedGraph ? (
        <div data-testid="library-install-graph" style={{ marginTop: 8 }}>
          <LibraryGraphBlock
            key={`${data.draftId}:${installFrames.length}`}
            data={installedGraph}
            defaultScope={typeof installedGraph.activeScope === "string" ? installedGraph.activeScope : "all"}
            onSelectNode={onSelectNode}
            fetchOnMount={false}
          />
        </div>
      ) : null}
    </>
  );
}

function LibraryInstallFrames({ frames }: { frames: LibrarySseFrame[] }) {
  if (frames.length === 0) return null;
  return (
    <div data-testid="library-install-sse-frames" style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {frames.map((frame, index) => (
        <div
          key={`${frame.event}:${index}`}
          style={{
            border: `1px solid ${frame.event === "library.error" ? "rgba(248,113,113,0.35)" : "var(--border)"}`,
            borderRadius: 6,
            padding: 8,
            background: frame.event === "library.error" ? "rgba(248,113,113,0.06)" : "var(--bg-subtle)",
          }}
        >
          <div style={{ fontSize: 11, color: frame.event === "library.error" ? "#f87171" : "var(--text-dim)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>
            {frame.event}
          </div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
            {JSON.stringify(frame.data, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? "(no output)" : text}
      </pre>
    </div>
  );
}

type SouthstarToolDetails = {
  mcpToolName?: string;
  piToolName?: string;
  structuredContent?: unknown;
};

type LibraryGraphPayload = Record<string, unknown> & {
  activeScope?: string;
  nodes: unknown[];
  edges: unknown[];
};

type LibraryImportCandidatePayload = {
  draftId: string;
  candidates: LibraryImportCandidate[];
  proposedEdges?: LibraryImportProposedEdge[];
};

function readSouthstarToolDetails(value: unknown): SouthstarToolDetails | null {
  const record = asRecord(value);
  if (!record) return null;
  const mcpToolName = typeof record.mcpToolName === "string" ? record.mcpToolName : undefined;
  const piToolName = typeof record.piToolName === "string" ? record.piToolName : undefined;
  if (!mcpToolName && !piToolName && record.structuredContent === undefined) return null;
  return { mcpToolName, piToolName, structuredContent: record.structuredContent };
}

function unwrapStructuredContent(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const result = asRecord(record.result);
  return result ?? record;
}

function isLibraryGraphTool(mcpToolName: string | undefined, piToolName: string | undefined): boolean {
  return mcpToolName === "southstar.library.get_graph" || piToolName === "southstar_library_get_graph";
}

function isLibraryImportTool(mcpToolName: string | undefined, piToolName: string | undefined): boolean {
  return mcpToolName === "southstar.library.import_from_source" || piToolName === "southstar_library_import_from_source";
}

function inferSouthstarWorkspaceSurface(mcpToolName: string | undefined, piToolName: string | undefined): WorkspaceSurface | null {
  if (
    mcpToolName?.startsWith("southstar.library.")
    || piToolName?.startsWith("southstar_library_")
  ) {
    return "library";
  }
  if (isWorkflowTool(mcpToolName, piToolName)) return "workflow";
  return null;
}

function isWorkflowTool(mcpToolName: string | undefined, piToolName: string | undefined): boolean {
  return Boolean(
    mcpToolName?.startsWith("southstar.workflow.")
    || piToolName?.startsWith("southstar_workflow_"),
  );
}

function isLibraryGraphPayload(value: Record<string, unknown> | null): value is LibraryGraphPayload {
  return Boolean(value && Array.isArray(value.nodes) && Array.isArray(value.edges));
}

function isLibraryImportCandidatePayload(value: Record<string, unknown> | null): value is LibraryImportCandidatePayload {
  if (!value || typeof value.draftId !== "string" || !Array.isArray(value.candidates)) return false;
  const candidates = value.candidates.map(toLibraryImportCandidate);
  if (candidates.some((candidate) => candidate === null)) return false;
  value.candidates = candidates;
  return value.proposedEdges === undefined || (Array.isArray(value.proposedEdges) && value.proposedEdges.every(isLibraryImportProposedEdge));
}

function toLibraryImportCandidate(value: unknown): LibraryImportCandidate | null {
  const record = asRecord(value);
  if (
    !record
    || typeof record.objectKey !== "string"
    || (record.kind !== "agent" && record.kind !== "skill" && record.kind !== "mcp" && record.kind !== "tool")
    || typeof record.title !== "string"
    || typeof record.scope !== "string"
  ) {
    return null;
  }
  return {
    objectKey: record.objectKey,
    kind: record.kind,
    title: record.title,
    scope: record.scope,
    ...(typeof record.domain === "string" ? { domain: record.domain } : {}),
    ...(typeof record.displayDomain === "string" ? { displayDomain: record.displayDomain } : {}),
    ...(typeof record.classificationReason === "string" ? { classificationReason: record.classificationReason } : {}),
    ...(typeof record.sourcePath === "string" ? { sourcePath: record.sourcePath } : {}),
    selectedByDefault: typeof record.selectedByDefault === "boolean" ? record.selectedByDefault : true,
    ...(typeof record.confidence === "number" ? { confidence: record.confidence } : {}),
  };
}

function isLibraryImportProposedEdge(value: unknown): value is LibraryImportProposedEdge {
  const record = asRecord(value);
  return Boolean(
    record
    && typeof record.fromObjectKey === "string"
    && typeof record.edgeType === "string"
    && typeof record.toObjectKey === "string"
    && typeof record.confidence === "number"
  );
}

function workflowDagFromSouthstarToolResult(
  mcpToolName: string | undefined,
  piToolName: string | undefined,
  payload: Record<string, unknown> | null,
): WorkflowDag | null {
  if (!isWorkflowTool(mcpToolName, piToolName) || !payload) return null;
  const draft = asPlannerDraft(payload) ?? asPlannerDraft(asRecord(payload.draft)) ?? asPlannerDraft(asRecord(payload.orchestration));
  if (draft) return buildWorkflowDagFromPlannerDraft(draft);
  return asWorkflowDagFromNodePayload(payload);
}

function asWorkflowDagFromNodePayload(payload: Record<string, unknown>): WorkflowDag | null {
  const draftId = typeof payload.draftId === "string" ? payload.draftId : null;
  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : null;
  const status = typeof payload.status === "string" ? payload.status : "validated";
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : null;
  if (!draftId || !workflowId || !rawNodes?.length) return null;
  const validationIssues = Array.isArray(payload.validationIssues)
    ? payload.validationIssues.filter(isPlannerDraftValidationIssue)
    : [];
  const taskSummaries = rawNodes.map((node, index) => toTaskSummaryFromWorkflowNode(node, rawNodes[index - 1])).filter((node) => node !== null);
  if (taskSummaries.length === 0) return null;
  return buildWorkflowDagFromPlannerDraft({
    draftId,
    workflowId,
    status,
    validationIssues,
    goalPrompt: goalPromptFromWorkflowNodes(rawNodes) ?? workflowId,
    taskSummaries,
  });
}

function toTaskSummaryFromWorkflowNode(value: unknown, previousValue: unknown): V2PlannerDraftOrchestrationView["taskSummaries"][number] | null {
  const record = asRecord(value);
  if (!record || typeof record.taskId !== "string") return null;
  const previous = asRecord(previousValue);
  const nodePromptSpec = asRecord(record.nodePromptSpec);
  const taskName = typeof record.taskName === "string"
    ? record.taskName
    : typeof record.title === "string"
      ? record.title
      : titleFromTaskId(record.taskId);
  const explicitDependsOn = Array.isArray(record.dependsOn)
    ? record.dependsOn.filter((dependency) => typeof dependency === "string")
    : null;
  return {
    taskId: record.taskId,
    taskName,
    dependsOn: explicitDependsOn ?? (typeof previous?.taskId === "string" ? [previous.taskId] : []),
    roleRef: typeof nodePromptSpec?.nodeType === "string" ? nodePromptSpec.nodeType : typeof record.nodeType === "string" ? record.nodeType : undefined,
    agentProfileRef: typeof record.agentProfileRef === "string" ? record.agentProfileRef : undefined,
  };
}

function titleFromTaskId(taskId: string): string {
  return taskId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || taskId;
}

function goalPromptFromWorkflowNodes(nodes: unknown[]): string | null {
  for (const node of nodes) {
    const record = asRecord(node);
    const nodePromptSpec = asRecord(record?.nodePromptSpec);
    const goal = typeof nodePromptSpec?.goal === "string" ? nodePromptSpec.goal : null;
    if (goal) return goal;
  }
  return null;
}

function asPlannerDraft(value: unknown): V2PlannerDraftOrchestrationView | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.draftId !== "string"
    || typeof record.goalPrompt !== "string"
    || typeof record.workflowId !== "string"
    || typeof record.status !== "string"
    || !Array.isArray(record.validationIssues)
    || !Array.isArray(record.taskSummaries)
  ) {
    return null;
  }
  const taskSummaries = record.taskSummaries.filter(isPlannerDraftTaskSummary);
  if (taskSummaries.length === 0) return null;
  return {
    draftId: record.draftId,
    goalPrompt: record.goalPrompt,
    workflowId: record.workflowId,
    status: record.status,
    validationIssues: record.validationIssues.filter(isPlannerDraftValidationIssue),
    taskSummaries,
  };
}

function isPlannerDraftTaskSummary(value: unknown): value is V2PlannerDraftOrchestrationView["taskSummaries"][number] {
  const record = asRecord(value);
  return Boolean(
    record
    && typeof record.taskId === "string"
    && typeof record.taskName === "string"
    && Array.isArray(record.dependsOn)
    && record.dependsOn.every((dependency) => typeof dependency === "string")
  );
}

function isPlannerDraftValidationIssue(value: unknown): value is V2PlannerDraftOrchestrationView["validationIssues"][number] {
  const record = asRecord(value);
  return Boolean(record && typeof record.path === "string" && typeof record.message === "string");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function CustomMessageView({ message, workflowCwd, onWorkflowDagNodeSelect, onGoalContractSelect, onWorkflowGoalRevise }: { message: CustomMessage; workflowCwd?: string | null; onWorkflowDagNodeSelect?: (node: WorkflowDagNode) => void; onGoalContractSelect?: (dag: WorkflowDag) => void; onWorkflowGoalRevise?: (dag: WorkflowDag, choice?: string) => void }) {
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  if (message.customType === "southstar.workflow_dag") {
    const details = message.details as WorkflowDagCustomDetails | undefined;
    if (details?.dag) {
      return (
        <div style={{ marginBottom: 16 }}>
          <WorkflowDagBlock dag={details.dag} cwd={workflowCwd} onNodeSelect={onWorkflowDagNodeSelect} onGoalContractSelect={onGoalContractSelect} onReviseGoal={onWorkflowGoalRevise} />
        </div>
      );
    }
  }

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
          {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>hidden extension message</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  );
                })}
              </div>
            )}
            {text ? <MarkdownBody className="markdown-custom-message">{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>(no message)</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {text ? previewText(text) : "Show extension message"}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay
                ? (contentExpanded ? "Collapse" : "Expand")
                : (detailsExpanded ? "Hide details" : "Show details")}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
