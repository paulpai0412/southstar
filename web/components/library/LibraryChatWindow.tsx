"use client";

import { useCallback, useEffect, useState } from "react";
import { runLibraryChatCommand } from "@/lib/library/chat-stream";
import type { LibrarySseFrame } from "@/lib/library/types";
import { LibraryGraphBlock } from "./LibraryGraphBlock";
import { LibraryValidationBlock } from "./LibraryValidationBlock";

export function LibraryChatWindow({
  scope,
  pendingPrompt,
  onPromptConsumed,
}: {
  scope: string;
  pendingPrompt: string;
  onPromptConsumed: () => void;
}) {
  const [frames, setFrames] = useState<LibrarySseFrame[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);

  const submitText = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || running) return;
    setRunning(true);
    setFrames((current) => [...current, { event: "library.chat.delta", data: { prompt: text } }]);
    try {
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
