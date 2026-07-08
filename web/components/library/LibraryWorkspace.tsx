"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readLibraryFile, readLibraryGraphNeighborhood, readLibraryObjectDetail, saveLibraryFile, syncLibraryFile, unwrapEnvelope } from "@/lib/library/api";
import type { LibraryFileEnvelope, LibraryGraphReadModel, LibraryObjectDetail, LibrarySessionSummary, LibraryWorkspaceModel, LibraryWorkspaceObject } from "@/lib/library/types";
import type { SessionInfo, WorkspaceSurface } from "@/lib/types";
import { ChatWindow } from "../ChatWindow";
import { LibraryFileViewer } from "./LibraryFileViewer";
import type { LibraryGraphChartNode } from "./LibraryGraphChart";
import { LibrarySidebar } from "./LibrarySidebar";

type LibraryWorkspaceContextValue = {
  model: LibraryWorkspaceModel | null;
  selectedScope: string;
  selectedObjectKey?: string;
  selectedFilePath?: string;
  fileRecord: LibraryFileEnvelope | null;
  objectDetail: LibraryObjectDetail | null;
  edgeGraph: LibraryGraphReadModel | null;
  dirtyFileContent: string;
  statusFilter: string;
  saving: boolean;
  syncing: boolean;
  fileStatusMessage?: string;
  librarySessions: LibrarySessionSummary[];
  selectedChatSession: SessionInfo | null;
  selectedSessionId?: string;
  librarySessionKey: number;
  libraryNewSessionCwd: string | null;
  selectedCwd: string | null;
  modelsRefreshKey?: number;
  onAgentEnd?: () => void;
  onCwdChange?: (cwd: string | null) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
  loadWorkspace: () => void;
  refreshWorkspace: () => void;
  handleNewSession: () => void;
  handleSelectScope: (scope: string) => void;
  handleSelectObject: (object: LibraryWorkspaceObject) => void;
  handleSelectSession: (session: LibrarySessionSummary) => void;
  handleRenameSession: (sessionId: string, title: string) => void;
  handleDeleteSession: (sessionId: string) => void;
  handleSelectGraphNode: (node: LibraryGraphChartNode) => void;
  handleSessionActivity: (session: LibrarySessionSummary) => void;
  handleSharedSessionCreated: (session: SessionInfo) => void;
  setStatusFilter: (status: string) => void;
  updateDirtyFileContent: (content: string) => void;
  handleSaveAndSyncFile: () => void;
};

type SelectableLibraryObject = Pick<LibraryWorkspaceObject, "objectKey" | "title"> & {
  sourcePath?: string;
};

const LibraryWorkspaceContext = createContext<LibraryWorkspaceContextValue | null>(null);

export function LibraryWorkspaceProvider({
  children,
  onOpenFile,
  defaultCwd,
  modelsRefreshKey,
  onAgentEnd,
  onCwdChange,
  onWorkspaceSurfaceChange,
}: {
  children: ReactNode;
  onOpenFile?: (file: { objectKey: string; title: string; sourcePath?: string }) => void;
  defaultCwd?: string | null;
  modelsRefreshKey?: number;
  onAgentEnd?: () => void;
  onCwdChange?: (cwd: string | null) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
}) {
  const [model, setModel] = useState<LibraryWorkspaceModel | null>(null);
  const [selectedScope, setSelectedScope] = useState("all");
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | undefined>(undefined);
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>(undefined);
  const [fileRecord, setFileRecord] = useState<LibraryFileEnvelope | null>(null);
  const [objectDetail, setObjectDetail] = useState<LibraryObjectDetail | null>(null);
  const [edgeGraph, setEdgeGraph] = useState<LibraryGraphReadModel | null>(null);
  const [dirtyFileContent, setDirtyFileContent] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [fileStatusMessage, setFileStatusMessage] = useState<string | undefined>(undefined);
  const [librarySessions, setLibrarySessions] = useState<LibrarySessionSummary[]>([]);
  const [libraryChatSessions, setLibraryChatSessions] = useState<SessionInfo[]>([]);
  const [selectedChatSession, setSelectedChatSession] = useState<SessionInfo | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const [libraryNewSessionCwd, setLibraryNewSessionCwd] = useState<string | null>(defaultCwd ?? null);
  const [librarySessionKey, setLibrarySessionKey] = useState(0);
  const selectedFilePathRef = useRef<string | undefined>(undefined);
  const dirtyFileContentRef = useRef("");
  const loadRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const syncRequestRef = useRef(0);

  const loadWorkspaceWithCleanup = useCallback(() => {
    let cancelled = false;
    fetch(`/api/library/workspace?scope=${encodeURIComponent(selectedScope)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setModel(unwrapEnvelope<LibraryWorkspaceModel>(payload));
      })
      .catch(() => {
        if (!cancelled) setModel({ selectedScope, domains: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedScope]);

  const loadWorkspace = useCallback(() => {
    loadWorkspaceWithCleanup();
  }, [loadWorkspaceWithCleanup]);

  const loadLibrarySessions = useCallback(() => {
    let cancelled = false;
    const sessionsUrl = defaultCwd
      ? `/api/sessions?kind=library&cwd=${encodeURIComponent(defaultCwd)}`
      : "/api/sessions?scope=all&kind=library&limit=50&compact=1";
    fetch(sessionsUrl, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const sessions = readSharedLibrarySessions(payload);
        setLibraryChatSessions(sessions);
        setLibrarySessions(sessions.map(sessionSummaryFromSharedSession));
        setSelectedChatSession((current) => {
          if (!current) return current;
          return sessions.find((session) => session.id === current.id) ?? current;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLibraryChatSessions([]);
          setLibrarySessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [defaultCwd]);

  useEffect(() => {
    selectedFilePathRef.current = selectedFilePath;
  }, [selectedFilePath]);

  useEffect(() => loadWorkspaceWithCleanup(), [loadWorkspaceWithCleanup]);

  useEffect(() => loadLibrarySessions(), [loadLibrarySessions]);

  useEffect(() => {
    if (selectedChatSession && defaultCwd && selectedChatSession.cwd !== defaultCwd) {
      setSelectedChatSession(null);
      setSelectedSessionId(undefined);
      setLibraryNewSessionCwd(defaultCwd);
      return;
    }
    if (selectedChatSession) return;
    const nextCwd = defaultCwd ?? null;
    setLibraryNewSessionCwd((current) => current === nextCwd ? current : nextCwd);
  }, [defaultCwd, selectedChatSession]);

  const refreshWorkspace = useCallback(() => {
    loadWorkspace();
    loadLibrarySessions();
  }, [loadLibrarySessions, loadWorkspace]);

  const handleSessionActivity = useCallback((session: LibrarySessionSummary) => {
    setSelectedSessionId(session.id);
    setLibrarySessions((current) => {
      const existing = current.findIndex((item) => item.id === session.id);
      if (existing === -1) return [session, ...current];
      const next = [...current];
      next[existing] = { ...next[existing], ...session };
      return next;
    });
  }, []);

  const handleSelectSession = useCallback((session: LibrarySessionSummary) => {
    const chatSession = libraryChatSessions.find((item) => item.id === session.id);
    if (chatSession) {
      setSelectedChatSession(chatSession);
      setLibraryNewSessionCwd(null);
    }
    setSelectedSessionId(session.id);
  }, [libraryChatSessions]);

  const handleRenameSession = useCallback((sessionId: string, title: string) => {
    setLibrarySessions((current) => current.map((session) => session.id === sessionId ? { ...session, title } : session));
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    setLibrarySessions((current) => current.filter((session) => session.id !== sessionId));
    setLibraryChatSessions((current) => current.filter((session) => session.id !== sessionId));
    setSelectedSessionId((current) => current === sessionId ? undefined : current);
    setSelectedChatSession((current) => current?.id === sessionId ? null : current);
  }, []);

  const handleNewSession = useCallback(() => {
    setSelectedSessionId(undefined);
    setSelectedChatSession(null);
    setLibraryNewSessionCwd(defaultCwd ?? null);
    setLibrarySessionKey((value) => value + 1);
  }, [defaultCwd]);

  const handleSharedSessionCreated = useCallback((session: SessionInfo) => {
    const librarySession = { ...session, kind: "library" as const };
    setSelectedChatSession(librarySession);
    setSelectedSessionId(librarySession.id);
    setLibraryNewSessionCwd(null);
    setLibraryChatSessions((current) => mergeSharedSessions(current, [librarySession]));
    setLibrarySessions((current) => mergeLibrarySessions(current, [sessionSummaryFromSharedSession(librarySession)]));
  }, []);

  const updateDirtyFileContent = useCallback((content: string) => {
    dirtyFileContentRef.current = content;
    setDirtyFileContent(content);
  }, []);

  const resetSelectedFile = useCallback(() => {
    loadRequestRef.current += 1;
    detailRequestRef.current += 1;
    saveRequestRef.current += 1;
    syncRequestRef.current += 1;
    setSelectedObjectKey(undefined);
    selectedFilePathRef.current = undefined;
    setSelectedFilePath(undefined);
    setFileRecord(null);
    setObjectDetail(null);
    setEdgeGraph(null);
    updateDirtyFileContent("");
    setSaving(false);
    setSyncing(false);
    setFileStatusMessage(undefined);
  }, [updateDirtyFileContent]);

  const handleSelectScope = useCallback((scope: string) => {
    if (scope === selectedScope) return;
    resetSelectedFile();
    setSelectedScope(scope);
  }, [resetSelectedFile, selectedScope]);

  const selectObjectReference = useCallback((object: SelectableLibraryObject) => {
    if (object.objectKey === selectedObjectKey && selectedFilePath) return;

    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    const detailRequestId = detailRequestRef.current + 1;
    detailRequestRef.current = detailRequestId;
    saveRequestRef.current += 1;
    syncRequestRef.current += 1;
    setSelectedObjectKey(object.objectKey);
    setSaving(false);
    setSyncing(false);
    setFileStatusMessage(undefined);
    setObjectDetail(null);
    setEdgeGraph(null);

    const loadSourcePath = (sourcePath: string) => {
      selectedFilePathRef.current = sourcePath;
      setSelectedFilePath(sourcePath);
      setFileRecord(null);
      updateDirtyFileContent("");
      onOpenFile?.({ objectKey: object.objectKey, title: object.title, sourcePath });
      readLibraryFile(sourcePath)
        .then((record) => {
          if (loadRequestRef.current !== requestId || selectedFilePathRef.current !== sourcePath) return;
          setFileRecord(record);
          updateDirtyFileContent(record.content);
        })
        .catch((error: unknown) => {
          if (loadRequestRef.current !== requestId) return;
          selectedFilePathRef.current = undefined;
          setSelectedFilePath(undefined);
          setFileRecord(null);
          updateDirtyFileContent("");
          setFileStatusMessage(`Failed to load file: ${error instanceof Error ? error.message : String(error)}`);
        });
    };

    readLibraryObjectDetail(object.objectKey)
      .then((detail) => {
        if (detailRequestRef.current !== detailRequestId) return;
        setObjectDetail(detail);
        if (!object.sourcePath) {
          const sourcePath = sourcePathFromObjectDetail(detail);
          if (sourcePath) loadSourcePath(sourcePath);
        }
      })
      .catch((error: unknown) => {
        if (detailRequestRef.current !== detailRequestId) return;
        setFileStatusMessage(`Failed to load object detail: ${error instanceof Error ? error.message : String(error)}`);
      });

    readLibraryGraphNeighborhood({ objectKey: object.objectKey, scope: selectedScope, depth: 1 })
      .then((graph) => {
        if (detailRequestRef.current !== detailRequestId) return;
        setEdgeGraph(graph);
      })
      .catch(() => {
        if (detailRequestRef.current !== detailRequestId) return;
        setEdgeGraph(null);
      });

    if (!object.sourcePath) {
      selectedFilePathRef.current = undefined;
      setSelectedFilePath(undefined);
      setFileRecord(null);
      updateDirtyFileContent("");
      onOpenFile?.({ objectKey: object.objectKey, title: object.title });
      return;
    }

    loadSourcePath(object.sourcePath);
  }, [onOpenFile, selectedFilePath, selectedObjectKey, selectedScope, updateDirtyFileContent]);

  const handleSelectObject = useCallback((object: LibraryWorkspaceObject) => {
    selectObjectReference(object);
  }, [selectObjectReference]);

  const handleSelectGraphNode = useCallback((node: LibraryGraphChartNode) => {
    const object = findWorkspaceObjectByKey(model, node.objectKey);
    selectObjectReference(object ?? {
      objectKey: node.objectKey,
      title: node.title ?? node.objectKey,
    });
  }, [model, selectObjectReference]);

  const handleSaveAndSyncFile = useCallback(() => {
    if (!selectedFilePath || saving || syncing) return;
    const savePath = selectedFilePath;
    const savedContent = dirtyFileContent;
    const saveRequestId = saveRequestRef.current + 1;
    const syncRequestId = syncRequestRef.current + 1;
    const objectKey = selectedObjectKey;
    saveRequestRef.current = saveRequestId;
    syncRequestRef.current = syncRequestId;
    setSaving(true);
    setSyncing(false);
    setFileStatusMessage(undefined);
    saveLibraryFile(savePath, dirtyFileContent)
      .then((record) => {
        if (saveRequestRef.current !== saveRequestId || selectedFilePathRef.current !== savePath) return undefined;
        setFileRecord(record);
        if (dirtyFileContentRef.current === savedContent) {
          updateDirtyFileContent(record.content);
        }
        setSaving(false);
        setSyncing(true);
        return syncLibraryFile(savePath)
          .then(() => {
            if (syncRequestRef.current !== syncRequestId || selectedFilePathRef.current !== savePath || !objectKey) return;
            void readLibraryObjectDetail(objectKey)
              .then((detail) => {
                if (syncRequestRef.current === syncRequestId && selectedFilePathRef.current === savePath) setObjectDetail(detail);
              })
              .catch(() => undefined);
            void readLibraryGraphNeighborhood({ objectKey, scope: selectedScope, depth: 1 })
              .then((graph) => {
                if (syncRequestRef.current === syncRequestId && selectedFilePathRef.current === savePath) setEdgeGraph(graph);
              })
              .catch(() => undefined);
            loadWorkspace();
          });
      })
      .catch((error: unknown) => {
        if (selectedFilePathRef.current !== savePath) return;
        const phase = saving ? "save" : "sync";
        setFileStatusMessage(`Failed to ${phase} file: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (selectedFilePathRef.current === savePath) {
          setSaving(false);
          setSyncing(false);
        }
      });
  }, [dirtyFileContent, loadWorkspace, saving, selectedFilePath, selectedObjectKey, selectedScope, syncing, updateDirtyFileContent]);

  const value = useMemo<LibraryWorkspaceContextValue>(() => ({
    model,
    selectedScope,
    selectedObjectKey,
    selectedFilePath,
    fileRecord,
    objectDetail,
    edgeGraph,
    dirtyFileContent,
    statusFilter,
    saving,
    syncing,
    fileStatusMessage,
    librarySessions,
    selectedChatSession,
    selectedSessionId,
    librarySessionKey,
    libraryNewSessionCwd,
    selectedCwd: defaultCwd ?? null,
    modelsRefreshKey,
    onAgentEnd,
    onCwdChange,
    onWorkspaceSurfaceChange,
    loadWorkspace,
    refreshWorkspace,
    handleNewSession,
    handleSelectScope,
    handleSelectObject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleSelectGraphNode,
    handleSessionActivity,
    handleSharedSessionCreated,
    setStatusFilter,
    updateDirtyFileContent,
    handleSaveAndSyncFile,
  }), [
    dirtyFileContent,
    fileRecord,
    fileStatusMessage,
    handleSaveAndSyncFile,
    handleNewSession,
    handleSelectGraphNode,
    handleSelectObject,
    handleSelectScope,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleSessionActivity,
    handleSharedSessionCreated,
    librarySessions,
    librarySessionKey,
    libraryNewSessionCwd,
    loadWorkspace,
    model,
    modelsRefreshKey,
    objectDetail,
    onAgentEnd,
    onCwdChange,
    onWorkspaceSurfaceChange,
    refreshWorkspace,
    edgeGraph,
    saving,
    selectedChatSession,
    selectedFilePath,
    selectedObjectKey,
    selectedScope,
    defaultCwd,
    selectedSessionId,
    statusFilter,
    syncing,
    updateDirtyFileContent,
  ]);

  return <LibraryWorkspaceContext.Provider value={value}>{children}</LibraryWorkspaceContext.Provider>;
}

export function LibrarySidebarPanel() {
  const context = useLibraryWorkspaceContext();
  return (
    <div data-testid="library-sidebar" style={{ height: "100%", minHeight: 0, overflow: "auto" }}>
      <LibrarySidebar
        model={context.model}
        sessions={context.librarySessions}
        selectedSessionId={context.selectedSessionId}
        selectedScope={context.selectedScope}
        selectedObjectKey={context.selectedObjectKey}
        selectedCwd={context.selectedCwd}
        statusFilter={context.statusFilter}
        onCwdChange={context.onCwdChange}
        onSelectScope={context.handleSelectScope}
        onStatusFilterChange={context.setStatusFilter}
        onSelectSession={context.handleSelectSession}
        onRenameSession={context.handleRenameSession}
        onDeleteSession={context.handleDeleteSession}
        onNewSession={context.handleNewSession}
        onRefresh={context.refreshWorkspace}
        onSelectObject={context.handleSelectObject}
      />
    </div>
  );
}

export function LibraryWorkspace() {
  const context = useContext(LibraryWorkspaceContext);
  if (!context) {
    return (
      <LibraryWorkspaceProvider>
        <LibraryWorkspaceContent />
      </LibraryWorkspaceProvider>
    );
  }
  return <LibraryWorkspaceContent />;
}

export function LibraryGraphNodeSelectionBridge({
  selection,
}: {
  selection: { id: number; node: LibraryGraphChartNode } | null;
}) {
  const context = useLibraryWorkspaceContext();
  const lastSelectionIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selection) return;
    if (lastSelectionIdRef.current === selection.id) return;
    lastSelectionIdRef.current = selection.id;
    context.handleSelectGraphNode(selection.node);
  }, [context.handleSelectGraphNode, selection]);
  return null;
}

function LibraryWorkspaceContent() {
  const context = useLibraryWorkspaceContext();
  const canRenderLibraryChat = context.selectedChatSession || context.libraryNewSessionCwd;
  return (
    <div
      data-testid="library-workspace"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        height: "100%",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden" }}>
        {canRenderLibraryChat ? (
          <ChatWindow
            key={`library:${context.librarySessionKey}:${context.selectedSessionId ?? "new"}`}
            session={context.selectedChatSession}
            newSessionCwd={context.libraryNewSessionCwd}
            sessionKind="library"
            onAgentEnd={context.onAgentEnd}
            onSessionCreated={context.handleSharedSessionCreated}
            modelsRefreshKey={context.modelsRefreshKey}
            workflowMode={false}
            workflowCwd={context.selectedChatSession?.cwd ?? context.libraryNewSessionCwd}
            onLibraryGraphNodeSelect={context.handleSelectGraphNode}
            onWorkspaceSurfaceChange={context.onWorkspaceSurfaceChange}
          />
        ) : (
          <div data-testid="library-chat-empty-new" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
            Select or create a Library session
          </div>
        )}
      </main>
    </div>
  );
}

export function LibraryFileSidecarPanel() {
  const context = useLibraryWorkspaceContext();
  return (
    <div data-testid="library-file-sidecar" style={{ height: "100%", minHeight: 0, overflow: "auto" }}>
      <LibraryFileViewer
        selectedFilePath={context.selectedFilePath}
        fileRecord={context.fileRecord}
        objectDetail={context.objectDetail}
        edgeGraph={context.edgeGraph}
        content={context.dirtyFileContent}
        dirty={context.fileRecord ? context.dirtyFileContent !== context.fileRecord.content : false}
        saving={context.saving}
        syncing={context.syncing}
        statusMessage={context.fileStatusMessage}
        onContentChange={context.updateDirtyFileContent}
        onSaveAndSync={context.handleSaveAndSyncFile}
        onSelectGraphNode={context.handleSelectGraphNode}
      />
    </div>
  );
}

function useLibraryWorkspaceContext(): LibraryWorkspaceContextValue {
  const context = useContext(LibraryWorkspaceContext);
  if (!context) {
    throw new Error("Library workspace components must be rendered inside LibraryWorkspaceProvider");
  }
  return context;
}

function findWorkspaceObjectByKey(model: LibraryWorkspaceModel | null, objectKey: string): LibraryWorkspaceObject | undefined {
  if (!model) return undefined;
  for (const domain of model.domains) {
    if (domain.objects) {
      const direct = domain.objects.find((object) => object.objectKey === objectKey);
      if (direct) return direct;
    }
    if (domain.objectGroups) {
      for (const group of domain.objectGroups) {
        const grouped = group.objects.find((object) => object.objectKey === objectKey);
        if (grouped) return grouped;
      }
    }
  }
  return undefined;
}

function sourcePathFromObjectDetail(detail: LibraryObjectDetail): string | undefined {
  const sourcePath = detail.object.state?.sourcePath;
  return typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : undefined;
}

function readSharedLibrarySessions(payload: unknown): SessionInfo[] {
  const root = isRecord(payload) ? payload : {};
  const sessions = Array.isArray(root.sessions) ? root.sessions : [];
  return sessions.filter(isSessionInfo).slice(0, 50);
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!value || typeof value !== "object") return false;
  const session = value as SessionInfo;
  return typeof session.id === "string"
    && typeof session.path === "string"
    && typeof session.cwd === "string"
    && typeof session.created === "string"
    && typeof session.modified === "string"
    && typeof session.messageCount === "number"
    && typeof session.firstMessage === "string";
}

function sessionSummaryFromSharedSession(session: SessionInfo): LibrarySessionSummary {
  return {
    id: session.id,
    title: session.name || session.firstMessage || session.id,
    status: session.agentState?.running || session.agentState?.isStreaming ? "running" : "ready",
    modified: session.modified,
    detail: session.cwd,
    itemCount: session.messageCount,
  };
}

function mergeLibrarySessions(current: LibrarySessionSummary[], incoming: LibrarySessionSummary[]): LibrarySessionSummary[] {
  const byId = new Map<string, LibrarySessionSummary>();
  for (const session of [...current, ...incoming]) {
    const existing = byId.get(session.id);
    byId.set(session.id, existing ? { ...existing, ...session, title: existing.title || session.title } : session);
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.modified ?? "") - Date.parse(left.modified ?? ""))
    .slice(0, 50);
}

function mergeSharedSessions(current: SessionInfo[], incoming: SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of [...current, ...incoming]) {
    byId.set(session.id, { ...byId.get(session.id), ...session });
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified))
    .slice(0, 50);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
