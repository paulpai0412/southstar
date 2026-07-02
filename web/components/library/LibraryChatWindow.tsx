"use client";

import { useCallback, useEffect, useState } from "react";
import { approveLibraryImportDraft, createLibraryImportDraft } from "@/lib/library/api";
import { runLibraryChatCommand } from "@/lib/library/chat-stream";
import type { LibrarySseFrame } from "@/lib/library/types";
import { LibraryGraphBlock } from "./LibraryGraphBlock";
import { LibraryValidationBlock } from "./LibraryValidationBlock";

export function LibraryChatWindow({
  scope,
  pendingPrompt,
  onPromptConsumed,
  onLibraryChanged,
}: {
  scope: string;
  pendingPrompt: string;
  onPromptConsumed: () => void;
  onLibraryChanged?: () => void;
}) {
  const [frames, setFrames] = useState<LibrarySseFrame[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [draftStatuses, setDraftStatuses] = useState<Record<string, "draft" | "approving" | "approved">>({});

  const submitText = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || running) return;
    setRunning(true);
    setFrames((current) => [...current, { event: "library.chat.delta", data: { prompt: text } }]);
    try {
      if (isImportDraftPrompt(text)) {
        const draft = await createLibraryImportDraft({
          source: { kind: "paste", label: "Library chat prompt", content: text },
          scope,
        });
        setDraftStatuses((current) => ({ ...current, [draft.draftId]: "draft" }));
        setFrames((current) => [...current, {
          event: "library.proposal.created",
          data: {
            draftId: draft.draftId,
            status: draft.status,
            title: "Draft library proposal",
            objectKeys: draft.proposal.objectKeys,
            objectSummaries: draft.proposal.objectSummaries,
            dependencies: draft.proposal.dependencies,
            filePaths: draft.proposal.files.map((file) => file.relativePath),
          },
        }, {
          event: "library.command.completed",
          data: { draftId: draft.draftId, status: "ready_for_review" },
        }]);
        return;
      }
      await runLibraryChatCommand({
        prompt: text,
        scope,
        onFrame: (frame) => setFrames((current) => [...current, frame]),
      });
    } catch (error) {
      setFrames((current) => [...current, {
        event: "library.error",
        data: { message: error instanceof Error ? error.message : String(error) },
      }]);
    } finally {
      setRunning(false);
    }
  }, [running, scope]);

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
      onLibraryChanged?.();
    } catch (error) {
      setDraftStatuses((current) => ({ ...current, [draftId]: "draft" }));
      setFrames((current) => [...current, {
        event: "library.error",
        data: { draftId, message: error instanceof Error ? error.message : String(error) },
      }]);
    }
  }, [onLibraryChanged]);

  useEffect(() => {
    const text = pendingPrompt.trim();
    if (!text || running) return;
    onPromptConsumed();
    void submitText(text);
  }, [onPromptConsumed, pendingPrompt, running, submitText]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div data-testid="library-chat-timeline" style={{ flex: 1, overflow: "auto", padding: 14 }}>
        {frames.map((frame, index) => (
          <div key={`${frame.event}:${index}`} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>{frame.event}</div>
            {frame.event === "library.graph.snapshot" ? (
              <LibraryGraphBlock data={frame.data} defaultScope={scope} />
            ) : frame.event === "library.validation.completed" ? (
              <LibraryValidationBlock data={frame.data} />
            ) : frame.event === "library.proposal.created" && typeof frame.data.draftId === "string" ? (
              <LibraryImportDraftReview
                data={frame.data}
                status={draftStatuses[frame.data.draftId] ?? "draft"}
                onApprove={() => void approveDraft(frame.data.draftId as string)}
              />
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>{JSON.stringify(frame.data, null, 2)}</pre>
            )}
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", padding: 10, display: "flex", gap: 8 }}>
        <input
          data-testid="library-chat-input"
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="Ask Library..."
          style={{ flex: 1 }}
        />
        <button
          data-testid="library-chat-send"
          onClick={() => {
            const text = input;
            setInput("");
            void submitText(text);
          }}
          disabled={!input.trim() || running}
        >
          Send
        </button>
      </div>
    </div>
  );
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

function isImportDraftPrompt(prompt: string): boolean {
  return /\b(create|import)\b/i.test(prompt);
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
