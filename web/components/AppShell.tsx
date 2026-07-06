"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppModeRail, type AppMode } from "./AppModeRail";
import { SessionSidebar } from "./SessionSidebar";
import { WorkflowSidebar } from "./WorkflowSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { WorkflowResourceViewer } from "./WorkflowResourceViewer";
import { WorkflowNodeProfileEditor } from "./WorkflowNodeProfileEditor";
import { WorkflowStaticNodeProfile } from "./WorkflowStaticNodeProfile";
import { OperatorSidebar } from "./operator/OperatorSidebar";
import { OperatorTaskTabs } from "./operator/OperatorTaskTabs";
import { OperatorWorkspace } from "./operator/OperatorWorkspace";
import { LibraryFileSidecarPanel, LibraryGraphNodeSelectionBridge, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./library/LibraryWorkspace";
import type { LibraryGraphChartNode } from "./library/LibraryGraphChart";
import type { Tab } from "./TabBar";
import { SidecarShell, type SidecarMode } from "./SidecarShell";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { McpConfig } from "./McpConfig";
import { BranchNavigator } from "./BranchNavigator";
import { useOperatorOverview } from "@/hooks/useOperatorOverview";
import { useTheme } from "@/hooks/useTheme";
import { buildOperatorIncidents } from "@/lib/operator/incidents";
import type { SessionInfo, SessionTreeNode, WorkspaceSurface } from "@/lib/types";
import type { WorkflowDagNode, WorkflowTemplateSummary } from "@/lib/workflow/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { ReactNode } from "react";

type SessionCopyField = "file" | "id";
type ContextUsageInfo = { percent: number | null; contextWindow: number; tokens: number | null };

const LAST_CWD_STORAGE_KEY = "pi-web:last-cwd";
const SIDECAR_WIDTH_STORAGE_KEY = "pi-web:sidecar-width";
const DEFAULT_SIDECAR_WIDTH = 560;

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

function sameContextUsage(a: ContextUsageInfo | null | undefined, b: ContextUsageInfo | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.percent === b.percent &&
    a.contextWindow === b.contextWindow &&
    a.tokens === b.tokens
  );
}

function sameSessionStats(a: SessionStatsInfo | null, b: SessionStatsInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.sessionName === b.sessionName &&
    a.userMessages === b.userMessages &&
    a.assistantMessages === b.assistantMessages &&
    a.toolCalls === b.toolCalls &&
    a.toolResults === b.toolResults &&
    a.totalMessages === b.totalMessages &&
    a.tokens.input === b.tokens.input &&
    a.tokens.output === b.tokens.output &&
    a.tokens.cacheRead === b.tokens.cacheRead &&
    a.tokens.cacheWrite === b.tokens.cacheWrite &&
    a.tokens.total === b.tokens.total &&
    a.cost === b.cost &&
    sameContextUsage(a.contextUsage, b.contextUsage)
  );
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isDark, toggleTheme } = useTheme();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [workflowSelectedSession, setWorkflowSelectedSession] = useState<SessionInfo | null>(null);
  const [workflowNewSessionCwd, setWorkflowNewSessionCwd] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [workflowSessionKey, setWorkflowSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [skillsConfigCwd, setSkillsConfigCwd] = useState<string | null>(null);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const [chatWorkspaceSurface, setChatWorkspaceSurface] = useState<WorkspaceSurface>("chat");
  const [selectedLibraryGraphNode, setSelectedLibraryGraphNode] = useState<{ id: number; node: LibraryGraphChartNode } | null>(null);
  const [selectedWorkflowTemplate, setSelectedWorkflowTemplate] = useState<WorkflowTemplateSummary | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const workflowChatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by each ChatWindow, displayed in top bar
  const [chatSessionStats, setChatSessionStats] = useState<SessionStatsInfo | null>(null);
  const [workflowSessionStats, setWorkflowSessionStats] = useState<SessionStatsInfo | null>(null);
  const handleChatSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setChatSessionStats((prev) => sameSessionStats(prev, stats) ? prev : stats);
  }, []);
  const handleWorkflowSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setWorkflowSessionStats((prev) => sameSessionStats(prev, stats) ? prev : stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
    };
  }, []);

  // Context usage — populated by each ChatWindow, displayed in top bar
  const [chatContextUsage, setChatContextUsage] = useState<ContextUsageInfo | null>(null);
  const [workflowContextUsage, setWorkflowContextUsage] = useState<ContextUsageInfo | null>(null);
  const handleChatContextUsageChange = useCallback((usage: ContextUsageInfo | null) => {
    setChatContextUsage((prev) => sameContextUsage(prev, usage) ? prev : usage);
  }, []);
  const handleWorkflowContextUsageChange = useCallback((usage: ContextUsageInfo | null) => {
    setWorkflowContextUsage((prev) => sameContextUsage(prev, usage) ? prev : usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "session" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "session") => {
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, []);

  const openSessionStatsPanel = useCallback(() => {
    setActiveTopPanel("session");
  }, []);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  const [sidecarTabs, setSidecarTabs] = useState<Tab[]>([]);
  const [activeSidecarTabId, setActiveSidecarTabId] = useState<string | null>(null);
  const [sidecarMode, setSidecarMode] = useState<SidecarMode>("hidden");
  const [sidecarWidth, setSidecarWidth] = useState(DEFAULT_SIDECAR_WIDTH);

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.insertText("`" + relativePath + "`");
  }, []);

  const handleWorkflowTemplateMention = useCallback((template: WorkflowTemplateSummary) => {
    setSelectedWorkflowTemplate(template);
    setAppMode("workflow");
    requestAnimationFrame(() => {
      workflowChatInputRef.current?.insertText(
        `@workflow-template ${template.title} (${template.id})\n請引用此 workflow template 生成新的 workflow DAG 及 Agent profile：`,
      );
    });
  }, []);

  const handleAppModeChange = useCallback((mode: AppMode) => {
    setAppMode(mode);
    if (mode === "chat") setChatWorkspaceSurface("chat");
  }, []);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const operator = useOperatorOverview(activeCwd, appMode === "operator");
  const operatorIncidents = useMemo(() => buildOperatorIncidents(operator.model), [operator.model]);
  const [operatorSelectedRunId, setOperatorSelectedRunId] = useState<string | null>(null);
  const [operatorSelectedTaskId, setOperatorSelectedTaskId] = useState<string | null>(null);
  const [operatorSelectedIncidentId, setOperatorSelectedIncidentId] = useState<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(SIDECAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(storedWidth) && storedWidth > 0) setSidecarWidth(storedWidth);
    if (initialSessionId) return;
    const storedCwd = window.localStorage.getItem(LAST_CWD_STORAGE_KEY);
    if (!storedCwd) return;
    const controller = new AbortController();
    fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: storedCwd }),
      signal: controller.signal,
    })
      .then((res) => res.json().then((data: { cwd?: string }) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ok && data.cwd) {
          setActiveCwd(data.cwd);
          window.localStorage.setItem(LAST_CWD_STORAGE_KEY, data.cwd);
        } else {
          window.localStorage.removeItem(LAST_CWD_STORAGE_KEY);
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [initialSessionId]);

  useEffect(() => {
    if (appMode !== "operator") return;
    const runs = operator.model.runs;
    const defaultSelection = operator.model.defaultSelection;
    const selectedRunStillExists = Boolean(operatorSelectedRunId && runs.some((run) => run.runId === operatorSelectedRunId));

    if (selectedRunStillExists) {
      if (!operatorSelectedTaskId && defaultSelection?.runId === operatorSelectedRunId && defaultSelection.taskId) {
        setOperatorSelectedTaskId(defaultSelection.taskId);
      }
      return;
    }

    setOperatorSelectedRunId(null);
    setOperatorSelectedTaskId(null);
    setOperatorSelectedIncidentId(null);
  }, [appMode, operator.model.defaultSelection, operator.model.runs, operatorSelectedRunId, operatorSelectedTaskId]);

  const handleCwdChange = useCallback((cwd: string | null) => {
    setActiveCwd((prev) => prev === cwd ? prev : cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd) return;
    window.localStorage.setItem(LAST_CWD_STORAGE_KEY, cwd);
    if (cwd === activeCwd) {
      if (suppressCwdBumpRef.current) suppressCwdBumpRef.current = false;
      return;
    }
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // Close any session that belongs to a different cwd — it no longer
    // matches the selected project directory.
    setSelectedSession((prev) => {
      if (prev && prev.cwd !== cwd) return null;
      return prev;
    });
    setWorkflowSelectedSession((prev) => {
      if (prev && prev.cwd !== cwd) return null;
      return prev;
    });
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setWorkflowNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setWorkflowSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [activeCwd, router]);

  useEffect(() => {
    if (!activeCwd) return;
    const controller = new AbortController();
    fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: activeCwd }),
      signal: controller.signal,
    })
      .then((res) => res.json().then((data: { cwd?: string }) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          if (!selectedSession && !newSessionCwd) {
            window.localStorage.removeItem(LAST_CWD_STORAGE_KEY);
            setActiveCwd(null);
          }
          return;
        }
        if (data.cwd && data.cwd !== activeCwd) {
          setActiveCwd(data.cwd);
          window.localStorage.setItem(LAST_CWD_STORAGE_KEY, data.cwd);
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [activeCwd, newSessionCwd, selectedSession]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setActiveCwd(session.cwd || null);
    if (session.cwd) window.localStorage.setItem(LAST_CWD_STORAGE_KEY, session.cwd);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setActiveCwd(cwd);
    window.localStorage.setItem(LAST_CWD_STORAGE_KEY, cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleNewWorkflowSession = useCallback((_sessionId: string, cwd: string) => {
    setWorkflowSelectedSession(null);
    setWorkflowNewSessionCwd(cwd);
    setActiveCwd(cwd);
    window.localStorage.setItem(LAST_CWD_STORAGE_KEY, cwd);
    setWorkflowSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleSelectWorkflowSession = useCallback((session: SessionInfo) => {
    setWorkflowNewSessionCwd(null);
    setWorkflowSelectedSession(session);
    setActiveCwd(session.cwd || null);
    if (session.cwd) window.localStorage.setItem(LAST_CWD_STORAGE_KEY, session.cwd);
    setWorkflowSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const handleChatSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setActiveCwd(session.cwd || null);
    if (session.cwd) window.localStorage.setItem(LAST_CWD_STORAGE_KEY, session.cwd);
    setRefreshKey((k) => k + 1);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const handleWorkflowSessionCreated = useCallback((session: SessionInfo) => {
    setWorkflowNewSessionCwd(null);
    setWorkflowSelectedSession(session);
    setActiveCwd(session.cwd || null);
    if (session.cwd) window.localStorage.setItem(LAST_CWD_STORAGE_KEY, session.cwd);
    setRefreshKey((k) => k + 1);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleChatSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router]);

  const handleWorkflowSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setWorkflowSessionKey((k) => k + 1);
    setWorkflowNewSessionCwd(null);
    setWorkflowSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  const openSidecarTab = useCallback((tab: Tab) => {
    setSidecarTabs((prev) => {
      if (prev.find((item) => item.id === tab.id)) return prev;
      return [...prev, tab];
    });
    setActiveSidecarTabId(tab.id);
    setSidecarMode((mode) => mode === "hidden" ? "floating" : mode);
  }, []);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    openSidecarTab({ id: `file:${filePath}`, label: fileName, filePath, kind: "file" });
  }, [openSidecarTab]);

  const handleOpenLibraryFile = useCallback((file: { objectKey: string; title: string; sourcePath?: string }) => {
    const tab: Tab = {
      id: `library-file:${file.objectKey}`,
      label: file.title || file.objectKey,
      filePath: file.sourcePath ?? file.objectKey,
      kind: "libraryFile",
    };
    setSidecarTabs((current) => [...current.filter((item) => item.kind !== "libraryFile"), tab]);
    setActiveSidecarTabId(tab.id);
    setSidecarMode((mode) => mode === "hidden" ? "floating" : mode);
  }, []);

  const openOperatorTaskSidecar = useCallback((input: { runId: string; taskId: string; attentionId?: string }) => {
    const filePath = `${input.runId}/${input.taskId}`;
    const tabs: Tab[] = [
      { id: `operator-history:${filePath}`, label: "History", filePath, kind: "operatorHistory", ...input },
      { id: `operator-stream:${filePath}`, label: "Live SSE", filePath, kind: "operatorStream", ...input },
      { id: `operator-actions:${filePath}`, label: "Actions", filePath, kind: "operatorActions", ...input },
      { id: `operator-artifacts:${filePath}`, label: "Artifacts", filePath, kind: "operatorArtifacts", ...input },
    ];
    setSidecarTabs((current) => {
      const byId = new Map(current.filter((tab) => !tab.kind?.startsWith("operator")).map((tab) => [tab.id, tab]));
      for (const tab of tabs) byId.set(tab.id, byId.get(tab.id) || tab);
      return [...byId.values()];
    });
    setActiveSidecarTabId(`operator-history:${filePath}`);
    setSidecarMode((mode) => mode === "hidden" ? "floating" : mode);
  }, []);

  const openSkillsConfig = useCallback(async () => {
    const cwd = activeCwd
      ?? (appMode === "workflow" ? workflowSelectedSession?.cwd : selectedSession?.cwd)
      ?? (appMode === "workflow" ? workflowNewSessionCwd : newSessionCwd);
    if (cwd) {
      setSkillsConfigCwd(cwd);
      setSkillsConfigOpen(true);
      return;
    }
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string };
      if (data.cwd) {
        setActiveCwd(data.cwd);
        window.localStorage.setItem(LAST_CWD_STORAGE_KEY, data.cwd);
        setSkillsConfigCwd(data.cwd);
        setSkillsConfigOpen(true);
      }
    } catch {
      setSkillsConfigOpen(true);
    }
  }, [activeCwd, appMode, newSessionCwd, selectedSession?.cwd, workflowNewSessionCwd, workflowSelectedSession?.cwd]);

  const handleOpenWorkflowResource = useCallback((resourcePath: string, label: string) => {
    openSidecarTab({ id: `workflow:${resourcePath}`, label, filePath: resourcePath, kind: "workflowResource" });
  }, [openSidecarTab]);

  const handleChatWorkspaceSurfaceChange = useCallback((surface: WorkspaceSurface) => {
    setChatWorkspaceSurface((current) => current === surface ? current : surface);
  }, []);

  const handleLibraryGraphNodeSelect = useCallback((node: LibraryGraphChartNode) => {
    setChatWorkspaceSurface("library");
    setSelectedLibraryGraphNode((current) => ({ id: (current?.id ?? 0) + 1, node }));
  }, []);

  const handleWorkflowDagNodeSelect = useCallback((node: WorkflowDagNode) => {
    setChatWorkspaceSurface("workflow");
    const taskId = node.taskId ?? node.id;
    const mode = node.mode ?? (node.draftId ? "draft" : node.runId ? "runtime" : undefined);
    if (taskId && mode && (node.draftId || node.runId)) {
      const scopeId = node.draftId ?? node.runId;
      const tabId = `workflow-node-profile:${scopeId}:${taskId}`;
      openSidecarTab({
        id: tabId,
        label: "Node Profile",
        filePath: taskId,
        kind: "workflowNodeProfile",
        draftId: node.draftId,
        runId: node.runId,
        taskId,
        mode,
      });
      return;
    }
    openSidecarTab({
      id: `workflow-static-node-profile:${node.id}:${node.profileRef || node.agentRef}`,
      label: "Node Profile",
      filePath: node.profileResourcePath || taskId,
      kind: "workflowStaticNodeProfile",
      taskId,
      workflowNode: node,
    });
  }, [openSidecarTab]);

  const handleSidecarWidthCommit = useCallback((width: number) => {
    window.localStorage.setItem(SIDECAR_WIDTH_STORAGE_KEY, String(width));
  }, []);

  const handleCloseSidecarTab = useCallback((tabId: string) => {
    setSidecarTabs((prev) => {
      const closingIndex = prev.findIndex((tab) => tab.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      setActiveSidecarTabId((cur) => {
        if (cur !== tabId) return cur && next.some((tab) => tab.id === cur) ? cur : next[next.length - 1]?.id ?? null;
        return next[Math.min(Math.max(closingIndex, 0), next.length - 1)]?.id ?? null;
      });
      if (next.length === 0) setSidecarMode("hidden");
      return next;
    });
  }, []);

  const handleExportSession = useCallback(() => {
    const session = appMode === "workflow" ? workflowSelectedSession : selectedSession;
    if (!session) return;
    window.location.href = `/api/sessions/${encodeURIComponent(session.id)}/export`;
  }, [appMode, selectedSession, workflowSelectedSession]);

  // Show chat areas if a session is selected, or if we have a cwd to start a new session in.
  const chatCurrentCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? null;
  const workflowCurrentCwd = workflowSelectedSession?.cwd ?? workflowNewSessionCwd ?? activeCwd ?? null;
  const chatEffectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const workflowEffectiveNewSessionCwd = workflowNewSessionCwd ?? (workflowSelectedSession === null && activeCwd ? activeCwd : null);
  const chatShowChat = selectedSession !== null || chatEffectiveNewSessionCwd !== null;
  const workflowShowChat = workflowSelectedSession !== null || workflowEffectiveNewSessionCwd !== null;

  const activeSelectedSession = appMode === "workflow" ? workflowSelectedSession : appMode === "chat" ? selectedSession : null;
  const activeNewSessionCwd = appMode === "workflow" ? workflowNewSessionCwd : appMode === "chat" ? newSessionCwd : null;
  const showChat = appMode === "workflow" ? workflowShowChat : appMode === "chat" ? chatShowChat : false;

  const currentCwd = activeSelectedSession?.cwd ?? activeNewSessionCwd ?? activeCwd ?? null;
  const sessionStats = appMode === "workflow" ? workflowSessionStats : appMode === "chat" ? chatSessionStats : null;
  const contextUsage = appMode === "workflow" ? workflowContextUsage : appMode === "chat" ? chatContextUsage : null;
  const activeSidecarTab = sidecarTabs.find((t) => t.id === activeSidecarTabId) ?? null;
  const activeSidebarSurface: WorkspaceSurface = appMode === "chat" ? chatWorkspaceSurface : appMode;

  const renderSidecarContent = useCallback(() => {
    if (!activeSidecarTab?.filePath) {
      return (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
          No sidecar tab open
        </div>
      );
    }
    if (activeSidecarTab.kind === "workflowNodeProfile" && activeSidecarTab.taskId && activeSidecarTab.mode) {
      return (
        <WorkflowNodeProfileEditor
          draftId={activeSidecarTab.draftId}
          runId={activeSidecarTab.runId}
          taskId={activeSidecarTab.taskId}
          mode={activeSidecarTab.mode}
        />
      );
    }
    if (activeSidecarTab.kind === "workflowStaticNodeProfile" && activeSidecarTab.workflowNode) {
      return <WorkflowStaticNodeProfile node={activeSidecarTab.workflowNode} />;
    }
    if (activeSidecarTab.kind === "workflowResource") {
      return (
        <WorkflowResourceViewer
          resourcePath={activeSidecarTab.filePath}
          cwd={currentCwd ?? undefined}
        />
      );
    }
    if (activeSidecarTab.kind === "libraryFile") {
      return <LibraryFileSidecarPanel />;
    }
    if (
      activeSidecarTab.kind === "operatorHistory" ||
      activeSidecarTab.kind === "operatorStream" ||
      activeSidecarTab.kind === "operatorActions" ||
      activeSidecarTab.kind === "operatorArtifacts"
    ) {
      const attention = operator.model.attentionItems.find((item) => item.id === activeSidecarTab.attentionId)
        ?? operator.model.attentionItems.find((item) => item.runId === activeSidecarTab.runId && item.taskId === activeSidecarTab.taskId);
      return (
        <OperatorTaskTabs
          kind={activeSidecarTab.kind}
          runId={activeSidecarTab.runId || null}
          taskId={activeSidecarTab.taskId || null}
          commands={attention?.commands || []}
          commandResults={operator.model.commandResults}
          onCommandComplete={operator.refresh}
        />
      );
    }
    return <FileViewer filePath={activeSidecarTab.filePath} cwd={currentCwd ?? undefined} />;
  }, [activeSidecarTab, currentCwd, openOperatorTaskSidecar, operator.model.attentionItems, operator.model.commandResults, operator.refresh]);

  const handleWorkflowSidebarNewSession = useCallback(() => {
    if (!workflowCurrentCwd) return;
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    handleNewWorkflowSession(tempId, workflowCurrentCwd);
  }, [workflowCurrentCwd, handleNewWorkflowSession]);

  const handleWorkflowSidebarRefresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  const sidebarPanelStyle = (active: boolean) => ({
    display: active ? "flex" : "none",
    flexDirection: "column" as const,
    height: "100%",
    minHeight: 0,
    flex: "1 1 auto",
  });

  const modePanelStyle = (active: boolean) => ({
    position: "absolute" as const,
    inset: 0,
    display: active ? "block" : "none",
    overflow: "hidden",
  });

  const renderEmptyPlaceholder = () => activeCwd ? (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
      Select a session from the sidebar
    </div>
  ) : (
    <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
        <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
      </svg>
      <div>
        <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>Get Started</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
          <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>Select a project directory from the sidebar<br />
          <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>Add models via the <strong style={{ color: "var(--text)" }}>Models</strong> button at the bottom
        </div>
      </div>
    </div>
  );

  const sidebarContent = (
    <>
      <div data-testid="operator-sidebar-panel" style={sidebarPanelStyle(activeSidebarSurface === "operator")} aria-hidden={activeSidebarSurface !== "operator"}>
        <OperatorSidebar
          cwd={activeCwd}
          runs={operator.model.runs}
          incidents={operatorIncidents}
          selectedRunId={operatorSelectedRunId}
          selectedTaskId={operatorSelectedTaskId}
          selectedIncidentId={operatorSelectedIncidentId}
          error={operator.error}
          onCwdChange={handleCwdChange}
          onSelectRun={setOperatorSelectedRunId}
          onSelectIncident={(incident) => {
            setOperatorSelectedIncidentId(incident.id);
            if (incident.runId) setOperatorSelectedRunId(incident.runId);
            setOperatorSelectedTaskId(incident.taskId || null);
            if (incident.runId && incident.taskId) {
              openOperatorTaskSidecar({ runId: incident.runId, taskId: incident.taskId, attentionId: incident.sourceAttentionIds[0] });
            }
          }}
          onRefresh={operator.refresh}
        />
      </div>
      <div data-testid="workflow-sidebar-panel" style={sidebarPanelStyle(activeSidebarSurface === "workflow")} aria-hidden={activeSidebarSurface !== "workflow"}>
        <WorkflowSidebar
          cwd={workflowCurrentCwd}
          selectedSessionId={workflowSelectedSession?.id ?? null}
          selectedTemplateId={selectedWorkflowTemplate?.id ?? null}
          onSessionSelect={handleSelectWorkflowSession}
          onTemplateSelect={setSelectedWorkflowTemplate}
          onTemplateMention={handleWorkflowTemplateMention}
          onOpenResource={handleOpenWorkflowResource}
          onCwdChange={handleCwdChange}
          onNewSession={handleWorkflowSidebarNewSession}
          onRefreshSessions={handleWorkflowSidebarRefresh}
        />
      </div>
      <div data-testid="library-sidebar-panel" style={sidebarPanelStyle(activeSidebarSurface === "library")} aria-hidden={activeSidebarSurface !== "library"}>
        <LibrarySidebarPanel />
      </div>
      <div data-testid="chat-sidebar-panel" style={sidebarPanelStyle(activeSidebarSurface === "chat")} aria-hidden={activeSidebarSurface !== "chat"}>
        <SessionSidebar
          selectedSessionId={selectedSession?.id ?? null}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          initialSessionId={initialSessionId}
          onInitialRestoreDone={handleInitialRestoreDone}
          refreshKey={refreshKey}
          onSessionDeleted={handleSessionDeleted}
          selectedCwd={activeCwd}
          onCwdChange={handleCwdChange}
          onOpenFile={handleOpenFile}
          explorerRefreshKey={explorerRefreshKey}
          onAtMention={handleAtMention}
        />
      </div>
      <div data-testid="left-controls" style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          {
            label: "Models",
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            label: "Skills",
            onClick: () => { void openSkillsConfig(); },
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
            label: "MCP",
            onClick: () => setMcpConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4" />
                <path d="M12 18v4" />
                <path d="m4.93 4.93 2.83 2.83" />
                <path d="m16.24 16.24 2.83 2.83" />
                <path d="M2 12h4" />
                <path d="M18 12h4" />
                <path d="m4.93 19.07 2.83-2.83" />
                <path d="m16.24 7.76 2.83-2.83" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: ReactNode }[]).map(({ label, onClick, disabled, icon }) => (
          <button
            key={label}
            data-testid={label === "Models" ? "left-control-models" : label === "Skills" ? "left-control-skills" : "left-control-mcp"}
            onClick={onClick}
            disabled={disabled}
            title={label}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 32, padding: 0, background: "none", border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      .sidebar-overlay-backdrop {
        display: none;
      }
      .pi-app-shell {
        --pi-sidebar-width: 288px;
      }
      .sidebar-container {
        width: var(--pi-sidebar-width);
        min-width: var(--pi-sidebar-width);
        max-width: var(--pi-sidebar-width);
        flex: 0 0 var(--pi-sidebar-width);
        overflow: hidden;
        transition: width 180ms ease, min-width 180ms ease, max-width 180ms ease, flex-basis 180ms ease, transform 180ms ease;
      }
      .sidebar-container.sidebar-closed {
        width: 0;
        min-width: 0;
        max-width: 0;
        flex-basis: 0;
        border-right-color: transparent !important;
        pointer-events: none;
      }
      @media (max-width: 900px) {
        .pi-app-shell {
          --pi-sidebar-width: min(320px, calc(100vw - 56px));
        }
        .sidebar-overlay-backdrop {
          display: block;
        }
        .sidebar-container {
          position: fixed;
          top: 0;
          bottom: 0;
          left: 0;
          width: var(--pi-sidebar-width);
          min-width: var(--pi-sidebar-width);
          max-width: var(--pi-sidebar-width);
          height: 100dvh;
          box-shadow: 10px 0 28px rgba(0,0,0,0.18);
          transform: translateX(0);
        }
        .sidebar-container.sidebar-closed {
          width: var(--pi-sidebar-width);
          min-width: var(--pi-sidebar-width);
          max-width: var(--pi-sidebar-width);
          transform: translateX(calc(-1 * var(--pi-sidebar-width) - 1px));
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
        .sidebar-container {
          transition: none;
        }
      }
    `}</style>
    <LibraryWorkspaceProvider onOpenFile={handleOpenLibraryFile}>
    <LibraryGraphNodeSelectionBridge selection={selectedLibraryGraphNode} />
    <div className="pi-app-shell" style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className="sidebar-overlay-backdrop"
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        }}
      >
        {sidebarContent}
      </div>

      {/* Center: chat */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minWidth: 0,
        marginRight: sidecarMode === "pinned" ? `min(${sidecarWidth}px, calc(100vw - 24px))` : 0,
        transition: "margin-right 180ms ease",
      }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-pressed={isDark}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          {showChat && (
            <div data-testid="chat-topbar-controls" style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <button
                onClick={handleExportSession}
                disabled={!activeSelectedSession}
                title={activeSelectedSession ? "Export HTML" : "Export is available after the session is saved"}
                aria-label="Export HTML"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  width: 36,
                  padding: 0,
                  background: "none",
                  border: "none",
                  borderTop: "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  color: activeSelectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: activeSelectedSession ? "pointer" : "not-allowed",
                  opacity: activeSelectedSession ? 1 : 0.45,
                  flexShrink: 0,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  transition: "color 0.1s, background 0.1s, opacity 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!activeSelectedSession) return;
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = activeSelectedSession ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.background = "none";
                }}
              >
                <span style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: "transparent",
                  color: activeSelectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  flexShrink: 0,
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </span>
              </button>
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                iconOnly
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
            </div>
          )}
          <AppModeRail mode={appMode} onModeChange={handleAppModeChange} orientation="horizontal" />
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
            const t = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
            if (t) {
              tooltipParts.push(`in: ${t.input.toLocaleString()}`);
              tooltipParts.push(`out: ${t.output.toLocaleString()}`);
              tooltipParts.push(`cache read: ${t.cacheRead.toLocaleString()}`);
              tooltipParts.push(`cache write: ${t.cacheWrite.toLocaleString()}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => toggleTopPanel("session")}
                title={tooltip || "Session info"}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: sidecarMode === "hidden" ? 48 : 12,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {t && t.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                    {fmt(t.input)}
                  </span>
                )}
                {t && t.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {fmt(t.output)}
                  </span>
                )}
                {t && t.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                    {fmt(t.cacheRead)}
                  </span>
                )}
                {costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel === "session" && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              zIndex: 500,
            }}>
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const sessionRows = [
                      ...(sessionStats.sessionName ? [{ label: "Name", value: sessionStats.sessionName, copyField: null }] : []),
                      { label: "File", value: sessionStats.sessionFile ?? "In-memory", copyField: "file" as const },
                      { label: "ID", value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                      ["User", sessionStats.userMessages.toLocaleString()],
                      ["Assistant", sessionStats.assistantMessages.toLocaleString()],
                      ["Tool Calls", sessionStats.toolCalls.toLocaleString()],
                      ["Tool Results", sessionStats.toolResults.toLocaleString()],
                      ["Total", sessionStats.totalMessages.toLocaleString()],
                    ];
                    const tokenRows = [
                      ["Input", sessionStats.tokens.input.toLocaleString()],
                      ["Output", sessionStats.tokens.output.toLocaleString()],
                      ...(sessionStats.tokens.cacheRead > 0 ? [["Cache Read", sessionStats.tokens.cacheRead.toLocaleString()]] : []),
                      ...(sessionStats.tokens.cacheWrite > 0 ? [["Cache Write", sessionStats.tokens.cacheWrite.toLocaleString()]] : []),
                      ["Total", sessionStats.tokens.total.toLocaleString()],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                      ...(sessionStats.cost > 0 ? [["Cost", `$${sessionStats.cost.toFixed(4)}`]] : []),
                      ...(ctx?.contextWindow ? [["Context", `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? "Copied" : `Copy ${field === "file" ? "file path" : "session ID"}`}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>Session Info</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                        {section("Messages", messageRows)}
                        {section("Tokens", [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      Send a message or run /session to load session info
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Center content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div data-testid="operator-mode-panel" style={modePanelStyle(appMode === "operator")} aria-hidden={appMode !== "operator"}>
            <OperatorWorkspace
              overview={operator.model}
              selectedRunId={operatorSelectedRunId}
              selectedTaskId={operatorSelectedTaskId}
              selectedIncidentId={operatorSelectedIncidentId}
              incidents={operatorIncidents}
              error={operator.error}
              onSelectRun={(runId) => {
                setOperatorSelectedRunId(runId);
                setOperatorSelectedTaskId(null);
              }}
              onSelectTask={({ runId, taskId, attention }) => {
                setOperatorSelectedRunId(runId);
                setOperatorSelectedTaskId(taskId);
                openOperatorTaskSidecar({ runId, taskId, attentionId: attention?.id });
              }}
              onClearRun={() => {
                setOperatorSelectedRunId(null);
                setOperatorSelectedTaskId(null);
                setOperatorSelectedIncidentId(null);
              }}
            />
          </div>
          <div data-testid="library-mode-panel" style={modePanelStyle(appMode === "library")} aria-hidden={appMode !== "library"}>
            <LibraryWorkspace />
          </div>
          <div data-testid="chat-mode-panel" style={modePanelStyle(appMode === "chat")} aria-hidden={appMode !== "chat"}>
            {chatShowChat ? (
              <ChatWindow
                key={`chat:${sessionKey}`}
                session={selectedSession}
                newSessionCwd={chatEffectiveNewSessionCwd}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleChatSessionCreated}
                onSessionForked={handleChatSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onBranchDataChange={appMode === "chat" ? handleBranchDataChange : undefined}
                onSystemPromptChange={appMode === "chat" ? handleSystemPromptChange : undefined}
                onSessionStatsChange={appMode === "chat" ? handleChatSessionStatsChange : undefined}
                onSessionStatsPanelOpen={appMode === "chat" ? openSessionStatsPanel : undefined}
                onContextUsageChange={appMode === "chat" ? handleChatContextUsageChange : undefined}
                workflowMode={false}
                workflowCwd={chatCurrentCwd}
                onWorkflowDagNodeSelect={handleWorkflowDagNodeSelect}
                onLibraryGraphNodeSelect={handleLibraryGraphNodeSelect}
                onWorkspaceSurfaceChange={handleChatWorkspaceSurfaceChange}
              />
            ) : initialSessionRestored ? renderEmptyPlaceholder() : null}
          </div>
          <div data-testid="workflow-mode-panel" style={modePanelStyle(appMode === "workflow")} aria-hidden={appMode !== "workflow"}>
            {workflowShowChat ? (
            <ChatWindow
              key={`workflow:${workflowSessionKey}`}
              session={workflowSelectedSession}
              newSessionCwd={workflowEffectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleWorkflowSessionCreated}
              onSessionForked={handleWorkflowSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={workflowChatInputRef}
              onBranchDataChange={appMode === "workflow" ? handleBranchDataChange : undefined}
              onSystemPromptChange={appMode === "workflow" ? handleSystemPromptChange : undefined}
              onSessionStatsChange={appMode === "workflow" ? handleWorkflowSessionStatsChange : undefined}
              onSessionStatsPanelOpen={appMode === "workflow" ? openSessionStatsPanel : undefined}
              onContextUsageChange={appMode === "workflow" ? handleWorkflowContextUsageChange : undefined}
              workflowMode
              workflowTemplate={selectedWorkflowTemplate}
              workflowCwd={workflowCurrentCwd}
              onWorkflowDagNodeSelect={handleWorkflowDagNodeSelect}
            />
            ) : initialSessionRestored ? renderEmptyPlaceholder() : null}
          </div>
        </div>
      </div>

      <SidecarShell
        tabs={sidecarTabs}
        activeTabId={activeSidecarTabId}
        mode={sidecarMode}
        width={sidecarWidth}
        onModeChange={setSidecarMode}
        onWidthChange={setSidecarWidth}
        onWidthCommit={handleSidecarWidthCommit}
        onSelectTab={setActiveSidecarTabId}
        onCloseTab={handleCloseSidecarTab}
      >
        {renderSidecarContent()}
      </SidecarShell>
    </div>
    </LibraryWorkspaceProvider>
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {skillsConfigOpen && (skillsConfigCwd ?? currentCwd ?? activeCwd) && (
      <SkillsConfig cwd={(skillsConfigCwd ?? currentCwd ?? activeCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    <McpConfig
      open={mcpConfigOpen}
      cwd={currentCwd ?? activeCwd}
      onClose={() => setMcpConfigOpen(false)}
    />
    </>
  );
}
