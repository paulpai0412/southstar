"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { normalizeLibraryRelativePath, readLibraryFile, readLibraryGraphNeighborhood, readLibraryObjectDetail, readLibraryReadiness, readinessFromReconcile, saveLibraryFile, syncLibraryFile, unwrapEnvelope } from "@/lib/library/api";
import type { LibraryFileEnvelope, LibraryGraphReadModel, LibraryObjectDetail, LibraryReadinessView, LibraryWorkspaceModel, LibraryWorkspaceObject } from "@/lib/library/types";
import type { SessionInfo, WorkspaceSurface } from "@/lib/types";
import { ChatWindow } from "../ChatWindow";
import { LibraryFileViewer } from "./LibraryFileViewer";
import { LibraryReadinessBanner } from "./LibraryReadinessBanner";
import type { LibraryGraphChartNode, LibraryGraphSelectionGraph } from "./LibraryGraphChart";
import { LibrarySidebar } from "./LibrarySidebar";

type LibraryWorkspaceContextValue = {
  model: LibraryWorkspaceModel | null;
  selectedScope: string;
  selectedObjectKey?: string;
  selectedFilePath?: string;
  fileRecord: LibraryFileEnvelope | null;
  objectDetail: LibraryObjectDetail | null;
  edgeGraph: LibraryGraphReadModel | null;
  readiness: LibraryReadinessView;
  dirtyFileContent: string;
  statusFilter: string;
  saving: boolean;
  syncing: boolean;
  fileStatusMessage?: string;
  librarySessions: SessionInfo[];
  selectedSessionId?: string;
  selectedLibrarySession: SessionInfo | null;
  librarySessionKey: number;
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
  handleSelectSession: (session: SessionInfo) => void;
  handleRenameSession: (sessionId: string, title: string) => void;
  handleDeleteSession: (sessionId: string) => void;
  handleSelectGraphNode: (node: LibraryGraphChartNode) => void;
  handleSharedSessionCreated: (session: SessionInfo) => void;
  setStatusFilter: (status: string) => void;
  updateDirtyFileContent: (content: string) => void;
  handleSaveAndSyncFile: () => void;
};

type SelectableLibraryObject = Pick<LibraryWorkspaceObject, "objectKey" | "title"> & {
  objectKind?: string;
  status?: string;
  viewOnly?: boolean;
  sourcePath?: string;
  sourceContent?: string;
  metadata?: Record<string, unknown>;
  selectionGraph?: LibraryGraphSelectionGraph;
};

const LibraryWorkspaceContext = createContext<LibraryWorkspaceContextValue | null>(null);

const NOT_READY_LIBRARY_READINESS: LibraryReadinessView = {
  ready: false,
  status: "not_ready",
  snapshotHash: null,
  includedCount: 0,
  excludedCount: 0,
  diagnostics: [],
};

export function LibraryWorkspaceProvider({
  children,
  active = true,
  restoredSession,
  onOpenFile,
  defaultCwd,
  modelsRefreshKey,
  onAgentEnd,
  onCwdChange,
  onWorkspaceSurfaceChange,
  onSelectedSessionChange,
}: {
  children: ReactNode;
  active?: boolean;
  restoredSession?: SessionInfo | null;
  onOpenFile?: (file: { objectKey: string; title: string; sourcePath?: string }) => void;
  defaultCwd?: string | null;
  modelsRefreshKey?: number;
  onAgentEnd?: () => void;
  onCwdChange?: (cwd: string | null) => void;
  onWorkspaceSurfaceChange?: (surface: WorkspaceSurface) => void;
  onSelectedSessionChange?: (session: SessionInfo | null) => void;
}) {
  const [model, setModel] = useState<LibraryWorkspaceModel | null>(null);
  const [selectedScope, setSelectedScope] = useState("all");
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | undefined>(undefined);
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>(undefined);
  const [fileRecord, setFileRecord] = useState<LibraryFileEnvelope | null>(null);
  const [objectDetail, setObjectDetail] = useState<LibraryObjectDetail | null>(null);
  const [edgeGraph, setEdgeGraph] = useState<LibraryGraphReadModel | null>(null);
  const [readiness, setReadiness] = useState<LibraryReadinessView>(NOT_READY_LIBRARY_READINESS);
  const [dirtyFileContent, setDirtyFileContent] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [fileStatusMessage, setFileStatusMessage] = useState<string | undefined>(undefined);
  const [librarySessions, setLibrarySessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
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
    readLibraryReadiness()
      .then((currentReadiness) => {
        if (!cancelled) setReadiness(currentReadiness);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedScope]);

  const loadWorkspace = useCallback(() => {
    loadWorkspaceWithCleanup();
  }, [loadWorkspaceWithCleanup]);

  const loadLibrarySessions = useCallback(() => {
    let cancelled = false;
    fetch("/api/sessions?scope=all&kind=library&limit=50&compact=1", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        setLibrarySessions(readPiLibrarySessions(payload));
      })
      .catch(() => {
        // Keep locally created/restored sessions visible when the refresh route
        // is temporarily unavailable or loses a race with ChatWindow creation.
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    selectedFilePathRef.current = selectedFilePath;
  }, [selectedFilePath]);

  useEffect(() => {
    if (!active) return;
    return loadWorkspaceWithCleanup();
  }, [active, loadWorkspaceWithCleanup]);

  useEffect(() => {
    if (!active) return;
    return loadLibrarySessions();
  }, [active, loadLibrarySessions]);

  useEffect(() => {
    if (!restoredSession || restoredSession.kind !== "library") return;
    setSelectedSessionId(restoredSession.id);
    setLibrarySessions((current) => mergePiLibrarySessions(current, [restoredSession]));
    setLibrarySessionKey((value) => value + 1);
  }, [restoredSession]);

  const refreshWorkspace = useCallback(() => {
    loadWorkspace();
    loadLibrarySessions();
  }, [loadLibrarySessions, loadWorkspace]);

  const selectedLibrarySession = useMemo<SessionInfo | null>(() => {
    return librarySessions.find((item) => item.id === selectedSessionId) ?? null;
  }, [librarySessions, selectedSessionId]);

  useEffect(() => {
    onSelectedSessionChange?.(selectedLibrarySession);
  }, [onSelectedSessionChange, selectedLibrarySession]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    setSelectedSessionId(session.id);
    setLibrarySessionKey((value) => value + 1);
  }, []);

  const handleRenameSession = useCallback((sessionId: string, title: string) => {
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: title }),
    }).then((response) => {
      if (!response.ok) throw new Error("failed to rename library session");
      setLibrarySessions((current) => current.map((session) => session.id === sessionId ? { ...session, name: title } : session));
    }).catch(() => undefined);
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
      .then((response) => {
        if (!response.ok) throw new Error("failed to delete library session");
        setLibrarySessions((current) => current.filter((session) => session.id !== sessionId));
        setSelectedSessionId((current) => current === sessionId ? undefined : current);
      })
      .catch(() => undefined);
  }, []);

  const handleNewSession = useCallback(() => {
    setSelectedSessionId(undefined);
    setLibrarySessionKey((value) => value + 1);
  }, []);

  const handleSharedSessionCreated = useCallback((session: SessionInfo) => {
    setSelectedSessionId(session.id);
    setLibrarySessions((current) => mergePiLibrarySessions(current, [session]));
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

    if (object.viewOnly || object.status === "proposed" || object.status === "blocked" || object.status === "installed") {
      const relativePath = object.sourcePath ? normalizeLibraryRelativePath(object.sourcePath) : undefined;
      const syntheticState = {
        ...(object.metadata ?? {}),
        title: typeof object.metadata?.title === "string" ? object.metadata.title : object.title,
        ...(relativePath ? { sourcePath: relativePath } : {}),
      };
      setObjectDetail({
        object: {
          objectKey: object.objectKey,
          objectKind: object.objectKind ?? "library_candidate",
          status: object.status ?? "proposed",
          state: syntheticState,
        },
        inboundEdges: [],
        outboundEdges: [],
      });
      setEdgeGraph(object.selectionGraph ? {
        activeScope: object.selectionGraph.activeScope,
        nodes: object.selectionGraph.nodes,
        edges: object.selectionGraph.edges.map((edge) => ({
          ...edge,
          edgeType: edge.edgeType ?? "related",
        })),
      } : null);
      selectedFilePathRef.current = relativePath;
      setSelectedFilePath(relativePath);
      setFileRecord(null);
      updateDirtyFileContent(object.sourceContent ?? "");
      onOpenFile?.({ objectKey: object.objectKey, title: object.title, ...(relativePath ? { sourcePath: relativePath } : {}) });
      return;
    }

    const loadSourcePath = (sourcePath: string) => {
      const relativePath = normalizeLibraryRelativePath(sourcePath);
      selectedFilePathRef.current = relativePath;
      setSelectedFilePath(relativePath);
      setFileRecord(null);
      updateDirtyFileContent("");
      onOpenFile?.({ objectKey: object.objectKey, title: object.title, sourcePath: relativePath });
      readLibraryFile(relativePath)
        .then((record) => {
          if (loadRequestRef.current !== requestId || selectedFilePathRef.current !== relativePath) return;
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
  }, [onOpenFile, selectedScope, updateDirtyFileContent]);

  const handleSelectObject = useCallback((object: LibraryWorkspaceObject) => {
    selectObjectReference(object);
  }, [selectObjectReference]);

  const handleSelectGraphNode = useCallback((node: LibraryGraphChartNode) => {
    const object = findWorkspaceObjectByKey(model, node.objectKey);
    selectObjectReference(object ?? {
      objectKey: node.objectKey,
      title: node.title ?? node.objectKey,
      objectKind: node.objectKind,
      status: node.status,
      ...(node.viewOnly || node.selectionGraph ? { viewOnly: true } : {}),
      sourcePath: node.sourcePath,
      sourceContent: node.sourceContent,
      metadata: node.metadata,
      selectionGraph: node.selectionGraph,
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
          .then((result) => {
            if (syncRequestRef.current !== syncRequestId || selectedFilePathRef.current !== savePath) return;
            setReadiness(readinessFromReconcile(result.reconcile));
            if (!objectKey) return;
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
    readiness,
    dirtyFileContent,
    statusFilter,
    saving,
    syncing,
    fileStatusMessage,
    librarySessions,
    selectedSessionId,
    selectedLibrarySession,
    librarySessionKey,
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
    handleSharedSessionCreated,
    librarySessions,
    librarySessionKey,
    loadWorkspace,
    model,
    modelsRefreshKey,
    objectDetail,
    onAgentEnd,
    onCwdChange,
    onWorkspaceSurfaceChange,
    refreshWorkspace,
    edgeGraph,
    readiness,
    saving,
    selectedFilePath,
    selectedObjectKey,
    selectedScope,
    selectedLibrarySession,
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
  const canRenderLibraryChat = Boolean(context.selectedCwd);
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
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <LibraryReadinessBanner readiness={context.readiness} />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {canRenderLibraryChat ? (
            <ChatWindow
              key={context.librarySessionKey}
              session={context.selectedLibrarySession}
              newSessionCwd={context.selectedLibrarySession ? null : context.selectedCwd}
              sessionKind="library"
              libraryScope={context.selectedScope}
              onAgentEnd={context.onAgentEnd}
              onSessionCreated={context.handleSharedSessionCreated}
              modelsRefreshKey={context.modelsRefreshKey}
              workflowMode={false}
              workflowCwd={context.selectedCwd}
              onLibraryGraphNodeSelect={context.handleSelectGraphNode}
              onWorkspaceSurfaceChange={context.onWorkspaceSurfaceChange}
            />
          ) : (
            <div data-testid="library-chat-empty-new" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Select or create a Library session
            </div>
          )}
        </div>
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
  return typeof sourcePath === "string" && sourcePath.length > 0 ? normalizeLibraryRelativePath(sourcePath) : undefined;
}

function readPiLibrarySessions(payload: unknown): SessionInfo[] {
  const root = isRecord(payload) ? payload : {};
  const sessions = Array.isArray(root.sessions) ? root.sessions : [];
  return sessions.filter(isPiLibrarySession).filter((session) => session.visibility !== "internal").slice(0, 50);
}

function isPiLibrarySession(value: unknown): value is SessionInfo {
  if (!value || typeof value !== "object") return false;
  const session = value as SessionInfo;
  return typeof session.id === "string"
    && typeof session.cwd === "string"
    && session.kind === "library"
    && typeof session.modified === "string";
}

function mergePiLibrarySessions(current: SessionInfo[], incoming: SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of [...current, ...incoming]) {
    const existing = byId.get(session.id);
    byId.set(session.id, existing ? { ...existing, ...session, name: session.name ?? existing.name } : session);
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified))
    .slice(0, 50);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
