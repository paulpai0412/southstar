"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readLibraryFile, saveLibraryFile, syncLibraryFile, unwrapEnvelope } from "@/lib/library/api";
import type { LibraryFileEnvelope, LibraryWorkspaceModel, LibraryWorkspaceObject } from "@/lib/library/types";
import { LibraryChatWindow } from "./LibraryChatWindow";
import { LibraryFileViewer } from "./LibraryFileViewer";
import { LibrarySidebar } from "./LibrarySidebar";

export function LibraryWorkspace() {
  const [model, setModel] = useState<LibraryWorkspaceModel | null>(null);
  const [selectedScope, setSelectedScope] = useState("software");
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | undefined>(undefined);
  const [selectedFilePath, setSelectedFilePath] = useState<string | undefined>(undefined);
  const [fileRecord, setFileRecord] = useState<LibraryFileEnvelope | null>(null);
  const [dirtyFileContent, setDirtyFileContent] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [fileStatusMessage, setFileStatusMessage] = useState<string | undefined>(undefined);
  const [quickPrompt, setQuickPrompt] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState("");
  const selectedFilePathRef = useRef<string | undefined>(undefined);
  const dirtyFileContentRef = useRef("");
  const loadRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const syncRequestRef = useRef(0);

  const loadWorkspace = useCallback(() => {
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

  useEffect(() => {
    selectedFilePathRef.current = selectedFilePath;
  }, [selectedFilePath]);

  useEffect(() => loadWorkspace(), [loadWorkspace]);

  const handlePromptSubmit = useCallback(() => {
    const text = quickPrompt.trim();
    if (!text) return;
    setPendingPrompt(text);
    setQuickPrompt("");
  }, [quickPrompt]);

  const handlePromptConsumed = useCallback(() => {
    setPendingPrompt("");
  }, []);

  const updateDirtyFileContent = useCallback((content: string) => {
    dirtyFileContentRef.current = content;
    setDirtyFileContent(content);
  }, []);

  const resetSelectedFile = useCallback(() => {
    loadRequestRef.current += 1;
    saveRequestRef.current += 1;
    syncRequestRef.current += 1;
    setSelectedObjectKey(undefined);
    selectedFilePathRef.current = undefined;
    setSelectedFilePath(undefined);
    setFileRecord(null);
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

  const handleSelectObject = useCallback((object: LibraryWorkspaceObject) => {
    if (object.objectKey === selectedObjectKey && selectedFilePath) return;

    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    saveRequestRef.current += 1;
    syncRequestRef.current += 1;
    setSelectedObjectKey(object.objectKey);
    setSaving(false);
    setSyncing(false);
    setFileStatusMessage(undefined);
    if (!object.sourcePath) {
      selectedFilePathRef.current = undefined;
      setSelectedFilePath(undefined);
      setFileRecord(null);
      updateDirtyFileContent("");
      return;
    }

    const sourcePath = object.sourcePath;
    selectedFilePathRef.current = sourcePath;
    setSelectedFilePath(sourcePath);
    setFileRecord(null);
    updateDirtyFileContent("");
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
  }, [selectedFilePath, selectedObjectKey, updateDirtyFileContent]);

  const handleSaveFile = useCallback(() => {
    if (!selectedFilePath || saving) return;
    const savePath = selectedFilePath;
    const savedContent = dirtyFileContent;
    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    setSaving(true);
    setFileStatusMessage(undefined);
    saveLibraryFile(savePath, dirtyFileContent)
      .then((record) => {
        if (saveRequestRef.current !== requestId || selectedFilePathRef.current !== savePath) return;
        setFileRecord(record);
        if (dirtyFileContentRef.current === savedContent) {
          updateDirtyFileContent(record.content);
        }
      })
      .catch((error: unknown) => {
        if (saveRequestRef.current !== requestId || selectedFilePathRef.current !== savePath) return;
        setFileStatusMessage(`Failed to save file: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (saveRequestRef.current === requestId && selectedFilePathRef.current === savePath) setSaving(false);
      });
  }, [dirtyFileContent, saving, selectedFilePath, updateDirtyFileContent]);

  const handleSyncFile = useCallback(() => {
    if (!selectedFilePath || syncing) return;
    const syncPath = selectedFilePath;
    const requestId = syncRequestRef.current + 1;
    syncRequestRef.current = requestId;
    setSyncing(true);
    setFileStatusMessage(undefined);
    syncLibraryFile(syncPath)
      .catch((error: unknown) => {
        if (syncRequestRef.current !== requestId || selectedFilePathRef.current !== syncPath) return;
        setFileStatusMessage(`Failed to sync file: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (syncRequestRef.current === requestId && selectedFilePathRef.current === syncPath) setSyncing(false);
      });
  }, [selectedFilePath, syncing]);

  return (
    <div
      data-testid="library-workspace"
      style={{
        display: "grid",
        gridTemplateColumns: "260px minmax(0, 1fr) 360px",
        height: "100%",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <aside
        data-testid="library-sidebar"
        style={{ borderRight: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}
      >
        <LibrarySidebar
          model={model}
          selectedScope={selectedScope}
          selectedObjectKey={selectedObjectKey}
          statusFilter={statusFilter}
          onSelectScope={handleSelectScope}
          onStatusFilterChange={setStatusFilter}
          onSelectObject={handleSelectObject}
          prompt={quickPrompt}
          onPromptChange={setQuickPrompt}
          onPromptSubmit={handlePromptSubmit}
        />
      </aside>
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden" }}>
        <LibraryChatWindow
          scope={selectedScope}
          pendingPrompt={pendingPrompt}
          onPromptConsumed={handlePromptConsumed}
          onLibraryChanged={loadWorkspace}
        />
      </main>
      <aside
        data-testid="library-file-viewer"
        style={{ borderLeft: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}
      >
        <LibraryFileViewer
          selectedFilePath={selectedFilePath}
          fileRecord={fileRecord}
          content={dirtyFileContent}
          dirty={fileRecord ? dirtyFileContent !== fileRecord.content : false}
          saving={saving}
          syncing={syncing}
          statusMessage={fileStatusMessage}
          onContentChange={updateDirtyFileContent}
          onSave={handleSaveFile}
          onSync={handleSyncFile}
        />
      </aside>
    </div>
  );
}
