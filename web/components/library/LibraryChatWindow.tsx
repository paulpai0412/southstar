"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveLibraryImportDraft,
  readLibraryGraph,
} from "@/lib/library/api";
import { runLibraryCandidateInstallCommand, runLibraryChatCommand } from "@/lib/library/chat-stream";
import type { LibraryImportCandidate, LibraryImportProposedEdge, LibrarySessionSummary, LibrarySseFrame } from "@/lib/library/types";
import { ChatInput } from "../ChatInput";
import { LibraryCandidateMessageBlock } from "./LibraryCandidateMessageBlock";
import { LibraryGraphBlock } from "./LibraryGraphBlock";
import type { LibraryGraphChartNode } from "./LibraryGraphChart";
import { LibraryValidationBlock } from "./LibraryValidationBlock";

type LibraryModelEntry = {
  id: string;
  name: string;
  provider: string;
};

type LibrarySelectedModel = {
  provider: string;
  modelId: string;
};

type LibraryModelsResponse = {
  models?: Record<string, string>;
  modelList?: LibraryModelEntry[];
  defaultModel?: LibrarySelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
};

type LibraryThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

export function LibraryChatWindow({
  scope,
  pendingPrompt,
  onPromptConsumed,
  onLibraryChanged,
  onSelectGraphNode,
  onSessionActivity,
}: {
  scope: string;
  pendingPrompt: string;
  onPromptConsumed: () => void;
  onLibraryChanged?: () => void;
  onSelectGraphNode?: (node: LibraryGraphChartNode) => void;
  onSessionActivity?: (session: LibrarySessionSummary) => void;
}) {
  const [frames, setFrames] = useState<LibrarySseFrame[]>([]);
  const [running, setRunning] = useState(false);
  const [draftStatuses, setDraftStatuses] = useState<Record<string, "draft" | "approving" | "approved" | "installing" | "installed">>({});
  const modelControls = useLibraryModelControls();
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<LibraryThinkingLevel>("auto");
  const sessionCounterRef = useRef(0);
  const draftSessionIdsRef = useRef<Record<string, string>>({});

  const handleModelChange = useCallback((provider: string, modelId: string) => {
    modelControls.setSelectedModel({ provider, modelId });
  }, [modelControls]);

  const submitText = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || running) return;
    sessionCounterRef.current += 1;
    const sessionId = `library-local-session-${Date.now()}-${sessionCounterRef.current}`;
    const startedAt = new Date().toISOString();
    onSessionActivity?.({
      id: sessionId,
      title: titleFromPrompt(text),
      status: "running",
      modified: startedAt,
      detail: scope,
    });
    setRunning(true);
    setFrames((current) => [...current, { event: "library.chat.delta", data: { prompt: text } }]);
    try {
      await runLibraryChatCommand({
        prompt: text,
        scope,
        onFrame: (frame) => {
          const draftId = stringField(frame.data, "draftId");
          if (frame.event === "library.import.candidates" && draftId) {
            draftSessionIdsRef.current[draftId] = sessionId;
            setDraftStatuses((current) => ({ ...current, [draftId]: "draft" }));
            const candidateCount = Array.isArray(frame.data.candidates) ? frame.data.candidates.length : 0;
            onSessionActivity?.({
              id: sessionId,
              title: titleFromPrompt(text),
              status: "ready_for_review",
              modified: new Date().toISOString(),
              detail: `${candidateCount} ${candidateCount === 1 ? "item" : "items"}`,
              itemCount: candidateCount,
            });
          }
          if (frame.event === "library.proposal.created" && draftId) {
            draftSessionIdsRef.current[draftId] = sessionId;
            setDraftStatuses((current) => ({ ...current, [draftId]: "draft" }));
          }
          setFrames((current) => [...current, frame]);
        },
      });
      onSessionActivity?.({
        id: sessionId,
        title: titleFromPrompt(text),
        status: "ready_for_review",
        modified: new Date().toISOString(),
        detail: scope,
      });
    } catch (error) {
      onSessionActivity?.({
        id: sessionId,
        title: titleFromPrompt(text),
        status: "error",
        modified: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      });
      setFrames((current) => [...current, {
        event: "library.error",
        data: { message: error instanceof Error ? error.message : String(error) },
      }]);
    } finally {
      setRunning(false);
    }
  }, [onSessionActivity, running, scope]);

  const approveDraft = useCallback(async (draftId: string) => {
    setDraftStatuses((current) => ({ ...current, [draftId]: "approving" }));
    try {
      const approved = await approveLibraryImportDraft({
        draftId,
        actor: "operator",
        reason: "approved from library chat",
      });
      setDraftStatuses((current) => ({ ...current, [draftId]: "approved" }));
      setFrames((current) => [...current, {
        event: "library.file.saved",
        data: { draftId, filePaths: approved.files.map((file) => file.relativePath) },
      }, {
        event: "library.db.synced",
        data: { draftId, objectKeys: approved.proposal.objectKeys },
      }, {
        event: "library.command.completed",
        data: { draftId, status: "approved" },
      }]);
      const sessionId = draftSessionIdsRef.current[draftId];
      if (sessionId) {
        const itemCount = approved.proposal.objectKeys.length;
        onSessionActivity?.({
          id: sessionId,
          title: "Approved library import",
          status: "approved",
          modified: new Date().toISOString(),
          detail: `${itemCount} ${itemCount === 1 ? "item" : "items"}`,
          itemCount,
        });
      }
      onLibraryChanged?.();
    } catch (error) {
      setDraftStatuses((current) => ({ ...current, [draftId]: "draft" }));
      const sessionId = draftSessionIdsRef.current[draftId];
      if (sessionId) {
        onSessionActivity?.({
          id: sessionId,
          title: "Library import approval",
          status: "error",
          modified: new Date().toISOString(),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      setFrames((current) => [...current, {
        event: "library.error",
        data: { draftId, message: error instanceof Error ? error.message : String(error) },
      }]);
    }
  }, [onLibraryChanged, onSessionActivity]);

  const installCandidates = useCallback(async (draftId: string, selectedCandidateIds: string[]) => {
    setDraftStatuses((current) => ({ ...current, [draftId]: "installing" }));
    try {
      await runLibraryCandidateInstallCommand({
        draftId,
        selectedCandidateIds,
        actor: "operator",
        reason: "installed from library chat",
        onFrame: (frame) => setFrames((current) => [...current, frame]),
      });
      setDraftStatuses((current) => ({ ...current, [draftId]: "installed" }));
      const sessionId = draftSessionIdsRef.current[draftId];
      if (sessionId) {
        const itemCount = selectedCandidateIds.length;
        onSessionActivity?.({
          id: sessionId,
          title: "Installed library candidates",
          status: "installed",
          modified: new Date().toISOString(),
          detail: `${itemCount} ${itemCount === 1 ? "item" : "items"}`,
          itemCount,
        });
      }
      onLibraryChanged?.();
      const graph = await readLibraryGraph(scope);
      setFrames((current) => [...current, {
        event: "library.ontology.graph",
        data: graph,
      }]);
    } catch (error) {
      setDraftStatuses((current) => ({ ...current, [draftId]: "draft" }));
      const sessionId = draftSessionIdsRef.current[draftId];
      if (sessionId) {
        onSessionActivity?.({
          id: sessionId,
          title: "Library import install",
          status: "error",
          modified: new Date().toISOString(),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      setFrames((current) => [...current, {
        event: "library.error",
        data: { draftId, message: error instanceof Error ? error.message : String(error) },
      }]);
    }
  }, [onLibraryChanged, onSessionActivity, scope]);

  useEffect(() => {
    const text = pendingPrompt.trim();
    if (!text || running) return;
    onPromptConsumed();
    void submitText(text);
  }, [onPromptConsumed, pendingPrompt, running, submitText]);

  const isEmptyNew = frames.length === 0 && !running;
  const shouldAnchorBottom = frames.length > 0 || running;
  const chatInputElement = (
    <ChatInput
      onSend={(message) => void submitText(message)}
      onAbort={() => undefined}
      isStreaming={running}
      modelList={modelControls.modelList}
      modelNames={modelControls.modelNames}
      model={modelControls.selectedModel}
      onModelChange={handleModelChange}
      toolPreset={toolPreset}
      onToolPresetChange={setToolPreset}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={setThinkingLevel}
      availableThinkingLevels={modelControls.availableThinkingLevels}
      thinkingLevelMap={modelControls.thinkingLevelMap}
    />
  );

  return (
    <div data-testid="library-chat-window" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
      {isEmptyNew ? (
        <div
          data-testid="library-chat-empty-new"
          style={{
            display: "flex",
            flex: "1 1 auto",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            overflowY: "auto",
            padding: "32px 16px",
          }}
        >
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
                lineHeight: 1.4,
                overflow: "hidden",
              }}
            >
              <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
              <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Southstar Mission Engine</span>
            </div>
            <div data-testid="library-chat-composer" className="relative">
              {chatInputElement}
            </div>
          </div>
        </div>
      ) : (
      <>
      <div style={{ position: "relative", display: "flex", flex: "1 1 auto", overflow: "hidden" }}>
        <div
          data-testid="library-chat-timeline"
          style={{
            flex: "1 1 auto",
            overflowY: "auto",
            paddingTop: 4,
            scrollbarWidth: "none",
          }}
        >
          <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div
              style={{
                maxWidth: 820,
                margin: "0 auto",
                minHeight: "100%",
                display: "flex",
                flexDirection: "column",
                justifyContent: shouldAnchorBottom ? "flex-end" : "center",
              }}
            >
              {frames.map((frame, index) => (
                <div key={`${frame.event}:${index}`} style={{ padding: "12px 0" }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6, fontFamily: "var(--font-mono)" }}>{frame.event}</div>
                  {frame.event === "library.graph.snapshot" || frame.event === "library.ontology.graph" ? (
                    <LibraryGraphBlock data={frame.data} defaultScope={scope} onSelectNode={onSelectGraphNode} />
                  ) : frame.event === "library.validation.completed" ? (
                    <LibraryValidationBlock data={frame.data} />
                  ) : frame.event === "library.import.candidates" && typeof frame.data.draftId === "string" ? (
                    <LibraryCandidateMessageBlock
                      draftId={frame.data.draftId}
                      candidates={toImportCandidates(frame.data.candidates)}
                      proposedEdges={toProposedEdges(frame.data.proposedEdges)}
                      status={candidateStatus(draftStatuses[frame.data.draftId] ?? "draft")}
                      onInstall={(selectedCandidateIds) => void installCandidates(frame.data.draftId as string, selectedCandidateIds)}
                    />
                  ) : frame.event === "library.proposal.created" && typeof frame.data.draftId === "string" ? (
                    <LibraryImportDraftReview
                      data={frame.data}
                      status={legacyStatus(draftStatuses[frame.data.draftId] ?? "draft")}
                      onApprove={() => void approveDraft(frame.data.draftId as string)}
                    />
                  ) : (
                    <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12, border: "1px solid var(--border)", borderRadius: 6, padding: 10, background: "var(--bg-subtle)" }}>{JSON.stringify(frame.data, null, 2)}</pre>
                  )}
                </div>
              ))}
              {running && (
                <div className="py-2 text-[13px] text-text-muted">
                  <span className="animate-[pulse_1.5s_infinite]">Running library command...</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div
          data-testid="library-chat-minimap-spacer"
          aria-hidden="true"
          style={{ flex: `0 0 ${CHAT_MINIMAP_WIDTH}px`, width: CHAT_MINIMAP_WIDTH }}
        />
      </div>
      <div data-testid="library-chat-composer" className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }} />
        </div>
        {chatInputElement}
      </div>
      </>
      )}
    </div>
  );
}

function useLibraryModelControls() {
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<LibraryModelEntry[]>([]);
  const [selectedModel, setSelectedModel] = useState<LibrarySelectedModel | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<Record<string, string[]>>({});
  const [thinkingLevelMaps, setThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/models", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data: LibraryModelsResponse) => {
        const nextModelList = data.modelList ?? [];
        setModelNames(data.models ?? {});
        setModelList(nextModelList);
        setThinkingLevels(data.thinkingLevels ?? {});
        setThinkingLevelMaps(data.thinkingLevelMaps ?? {});
        setSelectedModel((current) => {
          if (current && nextModelList.some((item) => item.provider === current.provider && item.id === current.modelId)) {
            return current;
          }
          const defaultModel = data.defaultModel
            ? nextModelList.find((item) => item.provider === data.defaultModel?.provider && item.id === data.defaultModel?.modelId)
            : undefined;
          const fallback = defaultModel ?? nextModelList[0];
          return fallback ? { provider: fallback.provider, modelId: fallback.id } : null;
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, []);

  const selectedModelKey = selectedModel ? `${selectedModel.provider}:${selectedModel.modelId}` : "";
  return {
    modelNames,
    modelList,
    selectedModel,
    setSelectedModel,
    availableThinkingLevels: selectedModelKey ? (thinkingLevels[selectedModelKey] ?? null) : null,
    thinkingLevelMap: selectedModelKey ? (thinkingLevelMaps[selectedModelKey] ?? null) : null,
  };
}

function LibraryImportDraftReview({
  data,
  status,
  onApprove,
}: {
  data: Record<string, unknown>;
  status: "draft" | "approving" | "approved";
  onApprove: () => void;
}) {
  const objectKeys = Array.isArray(data.objectKeys) ? data.objectKeys.filter(isString) : [];
  const objectSummaries = Array.isArray(data.objectSummaries) ? data.objectSummaries.filter(isRecord) : [];
  const dependencies = Array.isArray(data.dependencies) ? data.dependencies.filter(isRecord) : [];
  const filePaths = Array.isArray(data.filePaths) ? data.filePaths.filter(isString) : [];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>{typeof data.title === "string" ? data.title : "Draft library proposal"}</div>
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{typeof data.draftId === "string" ? data.draftId : ""}</div>
      {objectSummaries.length > 0 ? (
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <div style={{ color: "var(--text-dim)", fontWeight: 700 }}>Objects</div>
          {objectSummaries.map((summary) => {
            const objectKey = stringField(summary, "objectKey");
            const title = stringField(summary, "title");
            const status = stringField(summary, "status");
            const relativePath = stringField(summary, "relativePath");
            return (
              <div key={objectKey || relativePath} style={{ display: "grid", gap: 2 }}>
                <div>{title || objectKey}</div>
                <div style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                  {objectKey} {status ? `/ ${status}` : ""} {relativePath ? `/ ${relativePath}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          {objectKeys.map((objectKey) => <div key={objectKey}>{objectKey}</div>)}
          {filePaths.map((filePath) => <div key={filePath}>{filePath}</div>)}
        </div>
      )}
      {dependencies.length > 0 && (
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <div style={{ color: "var(--text-dim)", fontWeight: 700 }}>Dependencies</div>
          {dependencies.map((dependency) => {
            const fromObjectKey = stringField(dependency, "fromObjectKey");
            const edgeType = stringField(dependency, "edgeType");
            const toObjectKey = stringField(dependency, "toObjectKey");
            return (
              <div key={`${fromObjectKey}:${edgeType}:${toObjectKey}`} style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                {fromObjectKey} - {edgeType} - {toObjectKey}
              </div>
            );
          })}
        </div>
      )}
      <div>
        <button type="button" onClick={onApprove} disabled={status !== "draft"}>
          {status === "approved" ? "Approved" : status === "approving" ? "Approving..." : "Approve"}
        </button>
      </div>
    </div>
  );
}

function toImportCandidates(value: unknown): LibraryImportCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is LibraryImportCandidate => (
    Boolean(candidate)
    && typeof candidate === "object"
    && typeof (candidate as { objectKey?: unknown }).objectKey === "string"
    && typeof (candidate as { kind?: unknown }).kind === "string"
    && typeof (candidate as { title?: unknown }).title === "string"
  ));
}

function toProposedEdges(value: unknown): LibraryImportProposedEdge[] {
  if (!Array.isArray(value)) return [];
  return value.filter((edge): edge is LibraryImportProposedEdge => (
    Boolean(edge)
    && typeof edge === "object"
    && typeof (edge as { fromObjectKey?: unknown }).fromObjectKey === "string"
    && typeof (edge as { edgeType?: unknown }).edgeType === "string"
    && typeof (edge as { toObjectKey?: unknown }).toObjectKey === "string"
  ));
}

function candidateStatus(status: "draft" | "approving" | "approved" | "installing" | "installed"): "draft" | "installing" | "installed" {
  if (status === "installing" || status === "installed") return status;
  return "draft";
}

function legacyStatus(status: "draft" | "approving" | "approved" | "installing" | "installed"): "draft" | "approving" | "approved" {
  if (status === "approving" || status === "approved") return status;
  return "draft";
}

function titleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 45)}...`;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}
