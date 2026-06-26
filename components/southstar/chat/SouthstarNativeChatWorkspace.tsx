"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SouthstarApiClient, SouthstarChatCapabilities } from "@/lib/southstar/api-client";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";
import { SouthstarBranchNavigator, type SouthstarBranchNode } from "./SouthstarBranchNavigator";
import { SouthstarChatInput, type AttachedImage, type SouthstarChatInputHandle } from "./SouthstarChatInput";
import { SouthstarChatMinimap, type SouthstarChatMessage, useSouthstarMessageRefs } from "./SouthstarChatMinimap";

type RuntimeStatus = {
  connection: "idle" | "connected" | "error";
  execution: "idle" | "thinking" | "streaming" | "running_tools" | "compacting";
  toolNames: string[];
  lastEventAt: number | null;
  reconnectCount: number;
  stalled: boolean;
};

export function SouthstarNativeChatWorkspace(props: {
  api: SouthstarApiClient;
  selectedRunId: string | null;
  selectedSessionId: string | null;
  onRuntimeStatusChange?: (status: RuntimeStatus | null) => void;
}) {
  const { api, onRuntimeStatusChange, selectedRunId, selectedSessionId } = props;
  const capabilities = useSouthstarPageModel(() => props.api.getUiChatCapabilities(), [props.api]);
  const sessionsMemory = useSouthstarPageModel(
    () => props.selectedRunId ? props.api.getUiSessionsMemory(props.selectedRunId, props.selectedSessionId ?? undefined) : Promise.resolve(null),
    [props.api, props.selectedRunId, props.selectedSessionId],
  );
  const chatSession = useSouthstarPageModel(
    () => props.api.getUiChatSession({ runId: props.selectedRunId ?? undefined, sessionId: props.selectedSessionId ?? undefined }),
    [props.api, props.selectedRunId, props.selectedSessionId],
  );
  const chatInputRef = useRef<SouthstarChatInputHandle | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [localMessages, setLocalMessages] = useState<SouthstarChatMessage[]>([]);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [model, setModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState("default");
  const [thinkingLevel, setThinkingLevel] = useState("auto");
  const [isSending, setIsSending] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);

  const chatCapabilities = capabilities.model ?? emptyCapabilities();
  const sessionMessages = useMemo(
    () => {
      const chatMessages = messagesFromChatSession(chatSession.model);
      return chatMessages.length > 0 ? chatMessages : messagesFromSessionsMemory(sessionsMemory.model, props.selectedSessionId);
    },
    [chatSession.model, sessionsMemory.model, props.selectedSessionId],
  );
  const messages = useMemo(() => [...sessionMessages, ...localMessages], [localMessages, sessionMessages]);
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant"),
    [messages],
  );
  const messageRefs = useSouthstarMessageRefs(visibleMessages.length);
  const branchTree = useMemo(
    () => branchTreeFromChatSession(chatSession.model) ?? buildBranchTree(visibleMessages),
    [chatSession.model, visibleMessages],
  );

  useEffect(() => {
    setLocalMessages([]);
    setActiveLeafId(null);
  }, [props.selectedRunId, props.selectedSessionId]);

  useEffect(() => {
    if (model || chatCapabilities.modelList.length === 0) return;
    const first = chatCapabilities.modelList[0]!;
    setModel({ provider: first.provider, modelId: first.modelId });
  }, [chatCapabilities.modelList, model]);

  useEffect(() => {
    const serverActiveLeafId = activeLeafIdFromChatSession(chatSession.model);
    const fallbackActiveLeafId = lastBranchLeafId(branchTree);
    const nextActiveLeafId = serverActiveLeafId ?? fallbackActiveLeafId;
    if (!nextActiveLeafId) {
      setActiveLeafId(null);
      return;
    }
    setActiveLeafId((current) => {
      if (serverActiveLeafId) return serverActiveLeafId;
      return current && findBranchNode(branchTree, current) ? current : nextActiveLeafId;
    });
  }, [branchTree, chatSession.model]);

  useEffect(() => {
    onRuntimeStatusChange?.({
      connection: capabilities.error || sessionsMemory.error || chatSession.error ? "error" : "connected",
      execution: isSending ? "thinking" : "idle",
      toolNames: selectedToolPreset(chatCapabilities, toolPreset)?.allowedTools ?? [],
      lastEventAt: messages.length > 0 ? Date.now() : null,
      reconnectCount: 0,
      stalled: false,
    });
    return () => onRuntimeStatusChange?.(null);
  }, [capabilities.error, chatCapabilities, chatSession.error, isSending, messages.length, onRuntimeStatusChange, sessionsMemory.error, toolPreset]);

  const appendMessage = useCallback((role: SouthstarChatMessage["role"], text: string) => {
    setLocalMessages((current) => [...current, {
      id: `local-${Date.now()}-${current.length}`,
      role,
      text,
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  const handleSend = useCallback(async (message: string, _images?: AttachedImage[]) => {
    appendMessage("user", message);
    setIsSending(true);
    try {
      const result = await api.sendChatMessage({
        runId: props.selectedRunId ?? undefined,
        sessionId: props.selectedSessionId ?? undefined,
        parentMessageId: activeLeafId ?? undefined,
        message,
        ...(model ? { model } : {}),
        toolPreset,
        thinkingLevel,
      }) as { messageId?: string };
      if (result.messageId) {
        setActiveLeafId(result.messageId);
        setLocalMessages((current) => reconcileLocalChatMessages(current, result.messageId));
      }
      await chatSession.refresh();
    } catch (caught) {
      appendMessage("system", (caught as Error).message);
    } finally {
      setIsSending(false);
    }
  }, [activeLeafId, api, appendMessage, chatSession, model, props.selectedRunId, props.selectedSessionId, thinkingLevel, toolPreset]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    await handleSend(message, images);
  }, [handleSend]);

  const handleFollowUp = useCallback((message: string) => {
    appendMessage("user", message);
    appendMessage("system", "Follow-up queued for this workspace.");
  }, [appendMessage]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    chatInputRef.current?.addImages(files);
  }, []);

  function onLeafChange(leafId: string | null) {
    setActiveLeafId(leafId);
    if (!leafId) return;
    const index = visibleMessages.findIndex((message) => message.id === leafId);
    if (index >= 0) messageRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section
      className="ss-native-chat-workspace"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="ss-native-chat-topbar">
        <SouthstarBranchNavigator
          tree={branchTree}
          activeLeafId={activeLeafId}
          onLeafChange={onLeafChange}
          hasSession={Boolean(props.selectedSessionId)}
        />
        <div>
          <strong>{props.selectedSessionId ?? "New chat"}</strong>
          <span>{props.selectedRunId ? `run ${props.selectedRunId}` : "no run selected"}</span>
        </div>
      </div>
      <div className="ss-native-chat-body">
        <div ref={scrollContainerRef} className="ss-native-chat-scroll">
          <div className="ss-native-message-stack">
            {sessionsMemory.pending || chatSession.pending ? <p className="ss-empty">Loading chat session.</p> : null}
            {messages.length === 0 && !sessionsMemory.pending && !chatSession.pending ? (
              <div className="ss-native-empty">
                <strong>Southstar chat</strong>
                <span>Select a session to inspect chat memory, or start a freeform message.</span>
              </div>
            ) : null}
            {messages.map((message) => {
              const visibleIndex = visibleMessages.findIndex((item) => item.id === message.id);
              const refProps = visibleIndex >= 0
                ? { ref: (node: HTMLDivElement | null) => { messageRefs.current[visibleIndex] = node; } }
                : {};
              return (
                <article key={message.id} className={`ss-native-message ss-${message.role}`} {...refProps}>
                  <header>
                    <strong>{message.role}</strong>
                    {message.timestamp ? <time>{message.timestamp}</time> : null}
                  </header>
                  <p>{message.text}</p>
                </article>
              );
            })}
          </div>
        </div>
        <SouthstarChatMinimap messages={messages} scrollContainer={scrollContainerRef} messageRefs={messageRefs} />
      </div>
      <SouthstarChatInput
        ref={chatInputRef}
        onSend={handleSend}
        onAbort={() => setIsSending(false)}
        onSteer={isSending ? handleSteer : undefined}
        onFollowUp={isSending ? handleFollowUp : undefined}
        isStreaming={isSending}
        model={model}
        modelList={chatCapabilities.modelList}
        onModelChange={(provider, modelId) => setModel({ provider, modelId })}
        skillCommands={chatCapabilities.skillCommands}
        toolPreset={toolPreset}
        toolPresets={chatCapabilities.toolPresets}
        onToolPresetChange={setToolPreset}
        thinkingLevel={thinkingLevel}
        thinkingLevels={chatCapabilities.thinkingLevels}
        onThinkingLevelChange={setThinkingLevel}
        onCompact={() => {
          setCompactError(null);
          appendMessage("system", "Compact requested for this workspace.");
        }}
        onAbortCompaction={() => setCompactError("Compaction aborted.")}
        isCompacting={false}
        attachmentsEnabled={false}
        compactError={compactError ?? capabilities.error ?? chatSession.error ?? sessionsMemory.error}
      />
    </section>
  );
}

function emptyCapabilities(): SouthstarChatCapabilities {
  return { domain: "unavailable", modelList: [], skillCommands: [], toolPresets: [], thinkingLevels: ["auto"] };
}

function messagesFromSessionsMemory(model: any, selectedSessionId: string | null): SouthstarChatMessage[] {
  const data = model?.data ?? model;
  const sessions = asArray<any>(data?.sessions);
  const memory = asArray<any>(data?.memory);
  const selected = selectedSessionId
    ? sessions.find((session) => stringValue(session?.id) === selectedSessionId)
    : sessions[0];
  const payload = asRecord(selected?.payload);
  const fromMessages = asArray<any>(payload.messages).map((entry, index) => messageFromEntry(entry, `session-${selected?.id ?? "unknown"}-${index}`));
  const sessionRows = fromMessages.filter((message): message is SouthstarChatMessage => message !== null);
  if (sessionRows.length > 0) return sessionRows;

  const summary = stringValue(payload.transcriptSummary ?? payload.summary ?? payload.title ?? payload.intent);
  const rows: SouthstarChatMessage[] = summary ? [{
    id: `session-summary-${selected?.id ?? "unknown"}`,
    role: "assistant",
    text: summary,
  }] : [];
  for (const item of memory) {
    const memoryPayload = asRecord(item?.payload);
    const text = stringValue(memoryPayload.text ?? memoryPayload.summary ?? memoryPayload.preference ?? item?.id);
    if (text) rows.push({ id: `memory-${item.id ?? rows.length}`, role: "system", text });
  }
  return rows;
}

function messagesFromChatSession(model: any): SouthstarChatMessage[] {
  const rows = asArray<any>(model?.messages);
  return rows
    .map((row) => ({
      id: stringValue(row?.id) ?? `chat-${Math.random().toString(16).slice(2)}`,
      role: normalizeRole(row?.role),
      text: stringValue(row?.text) ?? "",
      timestamp: stringValue(row?.createdAt),
    }))
    .filter((message) => message.text.length > 0);
}

function branchTreeFromChatSession(model: any): SouthstarBranchNode[] | null {
  const rows = asArray<any>(model?.branchTree);
  if (rows.length === 0) return null;
  return rows.map(branchNodeFromUnknown).filter((node): node is SouthstarBranchNode => node !== null);
}

export function activeLeafIdFromChatSession(model: any): string | null {
  const activeLeafId = stringValue(model?.activeLeafId);
  if (!activeLeafId) return null;
  const branchTree = branchTreeFromChatSession(model);
  if (!branchTree || branchTree.length === 0) return activeLeafId;
  return findBranchNode(branchTree, activeLeafId) ? activeLeafId : null;
}

export function reconcileLocalChatMessages(messages: SouthstarChatMessage[], confirmedMessageId?: string): SouthstarChatMessage[] {
  if (!confirmedMessageId) return messages;
  return messages.filter((message) => !(message.id.startsWith("local-") && message.role === "user"));
}

function branchNodeFromUnknown(value: unknown): SouthstarBranchNode | null {
  const row = asRecord(value);
  const id = stringValue(row.id);
  const label = stringValue(row.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    role: normalizeRole(row.role),
    children: asArray<unknown>(row.children).map(branchNodeFromUnknown).filter((node): node is SouthstarBranchNode => node !== null),
  };
}

function normalizeRole(value: unknown): "user" | "assistant" | "system" {
  return value === "assistant" || value === "system" ? value : "user";
}

function messageFromEntry(entry: any, id: string): SouthstarChatMessage | null {
  const role = stringValue(entry?.role);
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const content = entry?.content;
  return {
    id: stringValue(entry?.id) ?? id,
    role,
    text: typeof content === "string" ? content : stringifyContent(content),
    timestamp: stringValue(entry?.timestamp ?? entry?.createdAt),
  };
}

function stringifyContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const row = asRecord(item);
        return stringValue(row.text) ?? stringValue(row.content) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "string") return content;
  const serialized = JSON.stringify(content ?? {});
  return serialized === "{}" ? "" : serialized;
}

function buildBranchTree(messages: SouthstarChatMessage[]): SouthstarBranchNode[] {
  if (messages.length === 0) return [];
  const root: SouthstarBranchNode = { id: messages[0]!.id, label: messages[0]!.text, role: messages[0]!.role, children: [] };
  let current = root;
  for (const message of messages.slice(1)) {
    const child: SouthstarBranchNode = { id: message.id, label: message.text, role: message.role, children: [] };
    current.children = [child];
    current = child;
  }
  return [root];
}

function lastLeaf(node: SouthstarBranchNode): SouthstarBranchNode {
  return node.children && node.children.length > 0 ? lastLeaf(node.children[node.children.length - 1]!) : node;
}

function lastBranchLeafId(nodes: SouthstarBranchNode[]): string | null {
  const first = nodes[0];
  return first ? lastLeaf(first).id : null;
}

function findBranchNode(nodes: SouthstarBranchNode[], id: string): SouthstarBranchNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findBranchNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}

function selectedToolPreset(capabilities: SouthstarChatCapabilities, presetId: string) {
  return capabilities.toolPresets.find((preset) => preset.id === presetId) ?? capabilities.toolPresets[0];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
