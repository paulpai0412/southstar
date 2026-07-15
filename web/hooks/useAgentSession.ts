"use client";

import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  GoalDesignContent,
  GoalRequirementsContent,
  GoalRequirementSelection,
  GoalSliceSelection,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  buildSessionStats,
  latestGoalDesignDraftIdentity,
  latestGoalRequirementDraftIdentity,
  latestWorkflowDraftId,
  readCompactResult,
  workflowTemplatePolicyFrom,
} from "@/lib/agent-session-engine";
import type { CompactResultInfo } from "@/lib/agent-session-engine";
import { confirmGoalDesignStream, generateWorkflowDagStream, WorkflowGenerateHttpError } from "@/lib/workflow/generate-stream";
import { appendWorkflowStreamText, normalizeWorkflowStreamText } from "@/lib/workflow/stream-text";
import { goalRequirementsContentFromUnknown } from "@/components/GoalRequirementListBlock";
import { runLibraryChatCommand } from "@/lib/library/chat-stream";
import type { ToolEntry } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { WorkflowDag } from "@/lib/workflow/types";
import type { LibraryImportCandidate, LibraryImportProposedEdge, LibrarySseFrame } from "@/lib/library/types";
import type { SessionKind } from "@/lib/session-kind";
import { persistWorkflowUiMessage } from "@/lib/workflow/session-persistence-client";

export type { CompactResultInfo } from "@/lib/agent-session-engine";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

function libraryTextFromFrame(frame: LibrarySseFrame): string | null {
  const message = typeof frame.data.message === "string" ? frame.data.message : undefined;
  if (message) return `[${frame.event}] ${message}`;
  if (frame.event === "library.intent.completed" && typeof frame.data.intent === "string") return `[intent] ${frame.data.intent}`;
  if (frame.event === "library.command.completed") {
    const status = typeof frame.data.status === "string" ? frame.data.status : "completed";
    return `[done] ${status}`;
  }
  if (frame.event === "library.error") {
    const error = typeof frame.data.message === "string" ? frame.data.message : "Library command failed";
    return `[error] ${error}`;
  }
  return null;
}

function libraryCandidateBlock(input: {
  draftId: string;
  candidates: LibraryImportCandidate[];
  proposedEdges?: LibraryImportProposedEdge[];
}) {
  return {
    type: "libraryImportCandidates" as const,
    draftId: input.draftId,
    candidates: input.candidates,
    proposedEdges: input.proposedEdges,
  };
}

function toLibraryImportCandidates(value: unknown): LibraryImportCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is LibraryImportCandidate => (
    Boolean(candidate)
    && typeof candidate === "object"
    && typeof (candidate as { objectKey?: unknown }).objectKey === "string"
    && typeof (candidate as { kind?: unknown }).kind === "string"
    && typeof (candidate as { title?: unknown }).title === "string"
  ));
}

function toLibraryImportProposedEdges(value: unknown): LibraryImportProposedEdge[] {
  if (!Array.isArray(value)) return [];
  return value.filter((edge): edge is LibraryImportProposedEdge => (
    Boolean(edge)
    && typeof edge === "object"
    && typeof (edge as { fromObjectKey?: unknown }).fromObjectKey === "string"
    && typeof (edge as { edgeType?: unknown }).edgeType === "string"
    && typeof (edge as { toObjectKey?: unknown }).toObjectKey === "string"
  ));
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
};

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  workflowMode?: boolean;
  sessionKind?: SessionKind;
  libraryScope?: string;
  workflowTemplate?: unknown;
  workflowCwd?: string | null;
  onWorkflowDagNodeSelect?: (node: import("@/lib/workflow/types").WorkflowDagNode) => void;
  /** Receives every host-authoritative Goal Requirements SSE/result projection. */
  onGoalRequirements?: (content: GoalRequirementsContent) => void;
  goalDesignRevisionAnchor?: GoalSliceSelection | null;
  goalRequirementRevisionAnchor?: GoalRequirementSelection | null;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;
  const sessionKind = opts.sessionKind ?? (opts.workflowMode ? "workflow" : "chat");
  const effectiveNewSessionCwd = opts.workflowMode ? (opts.workflowCwd ?? newSessionCwd) : newSessionCwd;

  const isNew = session === null && effectiveNewSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const workflowAbortControllerRef = useRef<AbortController | null>(null);
  const workflowSubmissionRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const promptRunIdRef = useRef(0);

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : (currentModel ?? newSessionDefaultModel);

  const sessionStats = sessionStatsOverride ?? buildSessionStats({
    messages,
    sessionFile: data?.filePath || undefined,
    sessionId: sessionIdRef.current ?? session?.id ?? "",
    sessionName: session?.name,
    contextUsage,
  });

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    try {
      if (showLoading) setLoading(true);
      const url = includeState
        ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData & { agentState?: { running: boolean; state?: AgentStateResponse } };
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setCurrentModelOverride(null);
      setError(null);
      if (d.agentState?.state?.extensionStatuses) setExtensionStatuses(d.agentState.state.extensionStatuses);
      if (d.agentState?.state?.extensionWidgets) setExtensionWidgets(d.agentState.state.extensionWidgets);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
      return d.agentState ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const url = leafId
        ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
        : `/api/sessions/${encodeURIComponent(sid)}/context`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !effectiveNewSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: effectiveNewSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      kind: sessionKind,
    });
  }, [effectiveNewSessionCwd, isNew, onSessionCreated, sessionKind]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !effectiveNewSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      if (selectedModel) setPendingModel(selectedModel);
      const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/lib/tool-presets");
      const toolNames = toolPreset === "none" ? PRESET_NONE : toolPreset === "default" ? PRESET_DEFAULT : PRESET_FULL;
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: effectiveNewSessionCwd,
          type: "ensure_session",
          toolNames,
          sessionKind,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [effectiveNewSessionCwd, isNew, newSessionModel, newSessionDefaultModel, toolPreset, thinkingLevel, sessionKind]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const connectEvents = useCallback((sid: string): Promise<void> => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(settle, 1500);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle();
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        settle();
        if (eventSourceRef.current === es && agentRunningRef.current) {
          es.close();
          eventSourceRef.current = null;
          setTimeout(() => {
            if (agentRunningRef.current) void connectEvents(sid);
          }, 1000);
        }
      };
    });
  }, []);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const persistWorkflowMessage = useCallback(async (sessionId: string | null, message: AgentMessage) => {
    if (!sessionId) return;
    try {
      await persistWorkflowUiMessage(sessionId, message);
    } catch (error) {
      addNotice({
        type: "warning",
        message: `Workflow completed, but its UI history could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [addNotice]);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText ? [...rest, { key: request.statusKey, text: request.statusText }] : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
    }
  }, [addNotice, opts.chatInputRef]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId?: number) => {
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      if (!agentRunningRef.current) return;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      dispatch({ type: "end" });
      onAgentEnd?.();
    }
  }, [loadSession, onAgentEnd]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "prompt_done":
        if (!agentRunningRef.current) break;
        void finishPromptWithoutStream(sessionIdRef.current);
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, finishPromptWithoutStream, handleExtensionUiRequest, loadSession, onAgentEnd]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunning) return;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");
    const promptRunId = promptRunIdRef.current + 1;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;

    if (sessionKind === "library" && !images?.length) {
      let rawStreamedText = "";
      let libraryGraph: Record<string, unknown> | null = null;
      let libraryCandidates: { draftId: string; candidates: LibraryImportCandidate[]; proposedEdges?: LibraryImportProposedEdge[] } | null = null;
      const libraryAbortController = new AbortController();
      workflowAbortControllerRef.current?.abort();
      workflowAbortControllerRef.current = libraryAbortController;
      const updateStreamingMessage = () => {
        dispatch({
          type: "update",
          message: {
            role: "assistant",
            content: [
              ...(rawStreamedText ? [{ type: "text" as const, text: rawStreamedText.trimEnd() }] : []),
              ...(libraryGraph ? [{ type: "libraryGraph" as const, data: libraryGraph, defaultScope: opts.libraryScope ?? "all" }] : []),
              ...(libraryCandidates ? [libraryCandidateBlock(libraryCandidates)] : []),
            ],
            model: "library-chat",
            provider: "southstar",
            timestamp: Date.now(),
          },
        });
      };
      const appendLibraryText = (text: string) => {
        if (!text) return;
        rawStreamedText = rawStreamedText ? `${rawStreamedText}\n${text}` : text;
        updateStreamingMessage();
      };

      try {
        await runLibraryChatCommand({
          prompt: trimmedMessage,
          scope: opts.libraryScope ?? "all",
          signal: libraryAbortController.signal,
          onAccepted(sessionId) {
            sessionIdRef.current = sessionId;
            promoteNewSession(1, trimmedMessage);
          },
          onFrame(frame) {
            const text = libraryTextFromFrame(frame);
            if (text) appendLibraryText(text);
            if (frame.event === "library.graph.snapshot" || frame.event === "library.ontology.graph") {
              libraryGraph = frame.data;
              updateStreamingMessage();
            }
            if (frame.event === "library.import.candidates" && typeof frame.data.draftId === "string") {
              libraryCandidates = {
                draftId: frame.data.draftId,
                candidates: toLibraryImportCandidates(frame.data.candidates),
                proposedEdges: toLibraryImportProposedEdges(frame.data.proposedEdges),
              };
              updateStreamingMessage();
            }
          },
        });

        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [
            ...(rawStreamedText ? [{ type: "text" as const, text: rawStreamedText.trimEnd() }] : []),
            ...(libraryGraph ? [{ type: "libraryGraph" as const, data: libraryGraph, defaultScope: opts.libraryScope ?? "all" }] : []),
            ...(libraryCandidates ? [libraryCandidateBlock(libraryCandidates)] : []),
          ],
          model: "library-chat",
          provider: "southstar",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (e) {
        if (libraryAbortController.signal.aborted) {
          addNotice({ type: "info", message: "Library command stopped" });
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        addNotice({ type: "error", message });
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: [{ type: "text", text: `Library command failed: ${message}` }],
          model: "library-chat",
          provider: "southstar",
          errorMessage: message,
          timestamp: Date.now(),
        } as AgentMessage]);
      } finally {
        if (workflowAbortControllerRef.current === libraryAbortController) {
          workflowAbortControllerRef.current = null;
        }
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
      return;
    }

    if (opts.workflowMode && !images?.length && !isSlashCommandPrompt) {
      let rawStreamedText = "";
      let generatedDag: WorkflowDag | null = null;
      let recoverableIdentity: { draftId: string; runId?: string; error: string } | null = null;
      let reviewDraftIdentity: { draftId: string; status?: string; goalDesignPackageHash?: string; goalRequirementDraftHash?: string } | null = null;
      let executionSetIdentity: { executionSetId: string; sliceRunCount: number } | null = null;
      let goalDesignBlock: GoalDesignContent | null = null;
      let goalRequirementsBlock: GoalRequirementsContent | null = null;
      let workflowSessionId: string | null = null;
      const workflowAbortController = new AbortController();
      workflowAbortControllerRef.current?.abort();
      workflowAbortControllerRef.current = workflowAbortController;
      const goalDesignRevisionIdentity = opts.goalDesignRevisionAnchor ?? latestGoalDesignDraftIdentity(messages);
      const requirementRevisionIdentity = opts.goalRequirementRevisionAnchor ?? latestGoalRequirementDraftIdentity(messages);
      const revisionDraftId = requirementRevisionIdentity?.draftId ?? goalDesignRevisionIdentity?.draftId ?? latestWorkflowDraftId(messages);
      const updateStreamingMessage = () => {
        const streamedText = normalizeWorkflowStreamText(rawStreamedText);
        const content = [
          ...(streamedText ? [{ type: "text" as const, text: streamedText }] : []),
          ...(goalRequirementsBlock ? [goalRequirementsBlock] : []),
          ...(goalDesignBlock ? [goalDesignBlock] : []),
          ...(generatedDag ? [{ type: "workflowDag" as const, dag: generatedDag }] : []),
        ];
        dispatch({
          type: "update",
          message: {
            role: "assistant",
            content,
            model: "workflow-generate",
            provider: "southstar",
            timestamp: Date.now(),
          },
        });
      };
      const appendWorkflowText = (text: string, mode: "line" | "message.delta" = "line") => {
        if (!text) return;
        rawStreamedText = appendWorkflowStreamText(rawStreamedText, text, mode);
        updateStreamingMessage();
      };

      try {
        workflowSessionId = sessionIdRef.current ?? await ensureNewSession();
        if (workflowSessionId) promoteNewSession(1, trimmedMessage);
        await persistWorkflowMessage(workflowSessionId, userMsg);
        const workflowCwd = opts.workflowCwd ?? session?.cwd ?? newSessionCwd;
        const submissionFingerprint = `${workflowCwd ?? ""}\u0000${trimmedMessage}`;
        if (!revisionDraftId && workflowSubmissionRef.current?.fingerprint !== submissionFingerprint) {
          workflowSubmissionRef.current = { fingerprint: submissionFingerprint, idempotencyKey: crypto.randomUUID() };
        }
        await generateWorkflowDagStream({
          prompt: trimmedMessage,
          draftId: revisionDraftId,
          expectedPackageHash: goalDesignRevisionIdentity?.goalDesignPackageHash,
          expectedDraftHash: requirementRevisionIdentity?.expectedDraftHash,
          selectedSliceId: goalDesignRevisionIdentity?.selectedSliceId,
          selectedRequirementId: requirementRevisionIdentity?.requirementId,
          cwd: workflowCwd,
          ...(!revisionDraftId && workflowSubmissionRef.current ? { idempotencyKey: workflowSubmissionRef.current.idempotencyKey } : {}),
          goalDesignMode: "review_before_compose",
          templatePolicy: workflowTemplatePolicyFrom(opts.workflowTemplate),
          signal: workflowAbortController.signal,
          onMessage(text, event) {
            appendWorkflowText(text, event === "message.delta" ? "message.delta" : "line");
          },
          onStage(stage) {
            const label = stage.message || stage.stage;
            if (label) appendWorkflowText(`[${stage.stage ?? "planner.stage"}] ${label}`);
          },
          onHeartbeat(heartbeat) {
            if (heartbeat.phase) appendWorkflowText(`[heartbeat] ${heartbeat.phase}`);
          },
          onDraft(draft) {
            if (draft.draftId) appendWorkflowText(`[draft] ${draft.draftId}${draft.status ? ` ${draft.status}` : ""}`);
            if (draft.status === "requirements_review" && draft.draftId && draft.goalRequirementDraft) {
              const block = goalRequirementsContentFromUnknown({
                ...draft,
                phase: draft.goalDesignPhase ?? draft.status,
                goalRequirementDraftHash: draft.goalRequirementDraftHash,
              });
              if (block) {
                goalRequirementsBlock = block;
                opts.onGoalRequirements?.(block);
                reviewDraftIdentity = {
                  draftId: block.draftId,
                  status: block.status,
                  goalRequirementDraftHash: block.goalRequirementDraftHash,
                };
              }
            }
            if (draft.status === "needs_library_input") {
              for (const gap of draft.vocabularyGaps ?? []) {
                appendWorkflowText(`[library gap] ${gap.kind}: ${gap.requestedRef}`);
              }
              if (draft.libraryImportDraftId) appendWorkflowText(`[library import draft] ${draft.libraryImportDraftId}`);
            }
            if (draft.draftId && (
              draft.status === "ready_for_review"
              || draft.status === "needs_input"
              || draft.status === "needs_library_input"
            )) {
              reviewDraftIdentity = {
                draftId: draft.draftId,
                status: draft.status,
                ...(typeof draft.goalDesignPackageHash === "string" ? { goalDesignPackageHash: draft.goalDesignPackageHash } : {}),
                ...(typeof draft.goalRequirementDraftHash === "string" ? { goalRequirementDraftHash: draft.goalRequirementDraftHash } : {}),
              };
            }
          },
          onGoalDesign(goalDesign) {
            const draftId = typeof goalDesign.draftId === "string" ? goalDesign.draftId : undefined;
            if (!draftId) return;
            const status = typeof goalDesign.status === "string"
              ? goalDesign.status
              : typeof goalDesign.draftStatus === "string"
                ? goalDesign.draftStatus
                : undefined;
            const goalDesignPackageHash = typeof goalDesign.goalDesignPackageHash === "string"
              ? goalDesign.goalDesignPackageHash
              : undefined;
            reviewDraftIdentity = {
              draftId,
              ...(status ? { status } : {}),
              ...(goalDesignPackageHash ? { goalDesignPackageHash } : {}),
            };
            goalDesignBlock = {
              type: "goalDesign",
              draftId,
              ...(status ? { status } : {}),
              ...(goalDesignPackageHash ? { goalDesignPackageHash } : {}),
              ...(goalDesign.package !== undefined ? { package: goalDesign.package } : {}),
            };
            appendWorkflowText(`[goal_design] ${draftId}${goalDesignPackageHash ? ` ${goalDesignPackageHash.slice(0, 12)}` : ""}`);
          },
          onGoalRequirements(goalRequirements) {
            const block = goalRequirementsContentFromUnknown(goalRequirements);
            if (!block) return;
            goalRequirementsBlock = block;
            opts.onGoalRequirements?.(block);
            reviewDraftIdentity = {
              draftId: block.draftId,
              status: block.status,
              goalRequirementDraftHash: block.goalRequirementDraftHash,
            };
            appendWorkflowText(`[goal_requirements] ${block.draftId} ${block.goalRequirementDraftHash.slice(0, 12)}`);
          },
          onGoalContract(mission) {
            appendWorkflowText(`[goal] ${mission.goalContract.summary}`);
          },
          onCoverage(mission) {
            appendWorkflowText(`[coverage] ${mission.coverage.covered}/${mission.coverage.total}`);
          },
          onRun(run) {
            if (run.runStatus) appendWorkflowText(`[run] ${run.runStatus}`);
          },
          onExecutionSet(executionSet) {
            if (executionSet.executionSetId) {
              executionSetIdentity = {
                executionSetId: executionSet.executionSetId,
                sliceRunCount: executionSet.sliceRuns?.length ?? 0,
              };
              appendWorkflowText(`[execution_set] ${executionSet.executionSetId} · ${executionSet.sliceRuns?.length ?? 0} slice runs`);
            }
          },
          onApproval({ command }) {
            if (command) appendWorkflowText(`[approval] ${command.label}`);
          },
          onRecoverable({ result, error }) {
            recoverableIdentity = { draftId: result.draftId, runId: result.runId, error };
            appendWorkflowText(`[recoverable] draft ${result.draftId}${result.runId ? ` · run ${result.runId}` : ""} · ${error}`);
          },
          onDag(dag) {
            generatedDag = dag;
            updateStreamingMessage();
          },
        });

        if (!generatedDag) {
          const completedReviewDraft = reviewDraftIdentity as { draftId: string; status?: string; goalDesignPackageHash?: string; goalRequirementDraftHash?: string } | null;
          if (completedReviewDraft) {
            const streamedText = normalizeWorkflowStreamText(rawStreamedText);
            const statusText = completedReviewDraft.status === "needs_library_input"
              ? "needs approved Library vocabulary"
              : completedReviewDraft.status === "needs_input"
                ? "needs more input"
                : "is ready for review";
            const assistantMsg: AgentMessage = {
              role: "assistant",
              content: [
                { type: "text", text: streamedText || `Goal draft ${completedReviewDraft.draftId} ${statusText}.` },
                ...(goalDesignBlock ? [goalDesignBlock] : []),
                ...(goalRequirementsBlock ? [goalRequirementsBlock] : []),
              ],
              model: "workflow-generate",
              provider: "southstar",
              timestamp: Date.now(),
            } as AgentMessage;
            setMessages((prev) => [...prev, assistantMsg]);
            await persistWorkflowMessage(workflowSessionId, assistantMsg);
            addNotice({ type: "info", message: `Goal draft ${statusText}.` });
            workflowSubmissionRef.current = null;
            return;
          }
          const completedRecoverable = recoverableIdentity as { draftId: string; runId?: string; error: string } | null;
          if (completedRecoverable) {
            const streamedText = normalizeWorkflowStreamText(rawStreamedText);
            const assistantMsg: AgentMessage = {
              role: "assistant",
              content: [{ type: "text", text: streamedText || `Goal accepted as draft ${completedRecoverable.draftId}.` }],
              model: "workflow-generate",
              provider: "southstar",
              timestamp: Date.now(),
            } as AgentMessage;
            setMessages((prev) => [...prev, assistantMsg]);
            await persistWorkflowMessage(workflowSessionId, assistantMsg);
            addNotice({ type: "info", message: "Goal accepted; workflow details can be recovered from the persisted identity." });
            return;
          }
          const completedExecutionSet = executionSetIdentity as { executionSetId: string; sliceRunCount: number } | null;
          if (completedExecutionSet) {
            const streamedText = normalizeWorkflowStreamText(rawStreamedText);
            const assistantMsg: AgentMessage = {
              role: "assistant",
              content: [{ type: "text", text: streamedText || `Goal execution set ${completedExecutionSet.executionSetId} created with ${completedExecutionSet.sliceRunCount} slice runs.` }],
              model: "workflow-generate",
              provider: "southstar",
              timestamp: Date.now(),
            } as AgentMessage;
            setMessages((prev) => [...prev, assistantMsg]);
            await persistWorkflowMessage(workflowSessionId, assistantMsg);
            addNotice({ type: "success", message: "Goal execution set created." });
            workflowSubmissionRef.current = null;
            return;
          }
          throw new Error("workflow generate completed without a DAG");
        }
        workflowSubmissionRef.current = null;

        const streamedText = normalizeWorkflowStreamText(rawStreamedText);
        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [
            ...(streamedText ? [{ type: "text" as const, text: streamedText }] : []),
            { type: "workflowDag" as const, dag: generatedDag },
          ],
          model: "workflow-generate",
          provider: "southstar",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        await persistWorkflowMessage(workflowSessionId, assistantMsg);
      } catch (e) {
        if (workflowAbortController.signal.aborted) {
          addNotice({ type: "info", message: "Workflow generation stopped" });
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        const failure = e instanceof WorkflowGenerateHttpError && e.code === "library_not_ready"
          ? `Library is not ready: ${e.message}. Open Library to review and sync diagnostics, then retry this Goal.`
          : `Workflow generation failed: ${message}`;
        addNotice({ type: "error", message: failure });
        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [{ type: "text", text: failure }],
          model: "workflow-generate",
          provider: "southstar",
          errorMessage: message,
          timestamp: Date.now(),
        } as AgentMessage;
        setMessages((prev) => [...prev, assistantMsg]);
        await persistWorkflowMessage(workflowSessionId, assistantMsg);
      } finally {
        if (workflowAbortControllerRef.current === workflowAbortController) {
          workflowAbortControllerRef.current = null;
        }
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
      return;
    }

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      let sentSessionId: string | null = null;
      if (isNew && effectiveNewSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;

        if (existingSid) {
          sentSessionId = existingSid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            await sendAgentCommand(existingSid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
          }
          await connectEvents(existingSid);
          await sendAgentCommand(existingSid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        } else {
          if (selectedModel) setPendingModel(selectedModel);
          const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/lib/tool-presets");
          const toolNames = toolPreset === "none" ? PRESET_NONE : toolPreset === "default" ? PRESET_DEFAULT : PRESET_FULL;
          const res = await fetch("/api/agent/new", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cwd: effectiveNewSessionCwd,
              type: "ensure_session",
              toolNames,
              sessionKind,
              ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
              ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const result = await res.json() as { sessionId: string };
          const realId = result.sessionId;
          sessionIdRef.current = realId;
          sentSessionId = realId;
          await connectEvents(realId);
          await sendAgentCommand(realId, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await connectEvents(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [effectiveNewSessionCwd, isNew, newSessionModel, toolPreset, thinkingLevel, session, messages, agentRunning, connectEvents, ensureNewSession, promoteNewSession, waitForPromptSettlement, sessionKind, opts.workflowMode, opts.workflowCwd, opts.workflowTemplate, opts.libraryScope, opts.goalDesignRevisionAnchor, opts.goalRequirementRevisionAnchor, addNotice, persistWorkflowMessage]);

  const handleConfirmGoalDesign = useCallback(async (selection: GoalSliceSelection) => {
    const packageHash = selection.goalDesignPackageHash;
    if (!packageHash || agentRunningRef.current) return;
    const controller = new AbortController();
    workflowAbortControllerRef.current?.abort();
    workflowAbortControllerRef.current = controller;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "start" });
    let streamedText = "";
    let dag: WorkflowDag | null = null;
    const append = (text: string) => {
      if (!text) return;
      streamedText = appendWorkflowStreamText(streamedText, text, "line");
      dispatch({
        type: "update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: streamedText }],
          model: "workflow-generate",
          provider: "southstar",
          timestamp: Date.now(),
        },
      });
    };
    try {
      await confirmGoalDesignStream({
        draftId: selection.draftId,
        expectedPackageHash: packageHash,
        signal: controller.signal,
        onStage(stage) {
          append(stage.message || stage.stage || "");
        },
        onMessage(text) {
          append(text);
        },
        onRun(run) {
          append(run.runId ? `[run] ${run.runId} ${run.runStatus ?? ""}` : "[run] created");
        },
        onDag(nextDag) {
          dag = nextDag;
          dispatch({
            type: "update",
            message: {
              role: "assistant",
              content: [
                ...(streamedText ? [{ type: "text" as const, text: streamedText }] : []),
                { type: "workflowDag" as const, dag: nextDag },
              ],
              model: "workflow-generate",
              provider: "southstar",
              timestamp: Date.now(),
            },
          });
        },
      });
      if (!dag) throw new Error("goal design confirmation completed without a DAG");
      const confirmedDag = dag as WorkflowDag;
      const assistantMsg: AgentMessage = {
        role: "assistant",
        content: [
          ...(streamedText ? [{ type: "text" as const, text: streamedText }] : [{ type: "text" as const, text: "Goal design confirmed; DAG composed." }]),
          { type: "workflowDag" as const, dag: confirmedDag },
        ],
        model: "workflow-generate",
        provider: "southstar",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      await persistWorkflowMessage(sessionIdRef.current, assistantMsg);
      addNotice({ type: "success", message: "Goal design confirmed; DAG composed." });
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        addNotice({ type: "error", message });
        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [{ type: "text", text: `Goal design confirmation failed: ${message}` }],
          model: "workflow-generate",
          provider: "southstar",
          errorMessage: message,
          timestamp: Date.now(),
        } as AgentMessage;
        setMessages((prev) => [...prev, assistantMsg]);
        await persistWorkflowMessage(sessionIdRef.current, assistantMsg);
      }
    } finally {
      if (workflowAbortControllerRef.current === controller) workflowAbortControllerRef.current = null;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [addNotice, persistWorkflowMessage]);

  const handleAbort = useCallback(async () => {
    if (workflowAbortControllerRef.current) {
      workflowAbortControllerRef.current.abort();
      workflowAbortControllerRef.current = null;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, ensureNewSession, isCompacting, loadSession, promoteNewSession, onSessionStatsPanelOpen]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: `[steer] ${message}`, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, {
      role: "user",
      content: behavior === "steer" ? `[steer] ${message}` : message,
      timestamp: Date.now(),
    } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: message, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, []);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/lib/tool-presets");
    const toolNames = preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!agentRunningRef.current) return;
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    completionScrollAllowedRef.current = false;
  }, []);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
        }
      });
    }
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && completionScrollAllowedRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Load model list
  useEffect(() => {
    const modelCwd = effectiveNewSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const controller = new AbortController();
    fetch(modelsUrl, { signal: controller.signal }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((d: ModelsResponse) => {
      setModelNames(d.models);
      setModelThinkingLevels(d.thinkingLevels ?? {});
      setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
      const nextModelList = d.modelList ?? [];
      setModelList(nextModelList);
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const fallbackModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(fallbackModel ? { provider: fallbackModel.provider, modelId: fallbackModel.id } : null);
    }).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [effectiveNewSessionCwd, isNew, modelsRefreshKey, session?.cwd]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, sessionStats,
    slashCommands, slashCommandsLoading,
    notices: noticeState.visible, extensionDialog, extensionStatuses, extensionWidgets, respondToExtensionUi,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleConfirmGoalDesign, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    // Subscriptions
    handleAgentEventRef,
  };
}
