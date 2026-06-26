import { randomUUID } from "node:crypto";
import { buildChatSessionReadModelPg } from "../read-models/chat-session.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

type ChatMessageBody = {
  runId?: unknown;
  sessionId?: unknown;
  message?: unknown;
  parentMessageId?: unknown;
  model?: unknown;
  toolPreset?: unknown;
  thinkingLevel?: unknown;
};

export async function handleChatRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/v2/chat/sessions") {
    const body = await readJsonBody<ChatMessageBody>(request);
    const runId = optionalString(body.runId);
    const sessionId = optionalString(body.sessionId) ?? `chat-${randomUUID()}`;
    const message = requiredString(body.message, "message");
    const existing = await buildChatSessionReadModelPg(context.db, { runId, sessionId });
    const requestedParentMessageId = optionalString(body.parentMessageId);
    const parentMessageId = requestedParentMessageId
      ? requireExistingParentMessage(existing.messages, requestedParentMessageId)
      : existing.activeLeafId ?? undefined;
    const messageId = `chat-message-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const nextMessages = [
      ...existing.messages,
      {
        id: messageId,
        ...(parentMessageId ? { parentMessageId } : {}),
        role: "user" as const,
        text: message,
        createdAt,
      },
    ];

    await upsertRuntimeResourcePg(context.db, {
      resourceType: "chat_session",
      resourceKey: sessionId,
      ...(runId ? { runId } : {}),
      sessionId,
      scope: "chat",
      status: "active",
      payload: {
        schemaVersion: "southstar.ui.chat_session.v1",
        sessionId,
        messages: nextMessages,
        activeLeafId: messageId,
        ...(isRecord(body.model) ? { model: body.model } : {}),
        ...(optionalString(body.toolPreset) ? { toolPreset: optionalString(body.toolPreset) } : {}),
        ...(optionalString(body.thinkingLevel) ? { thinkingLevel: optionalString(body.thinkingLevel) } : {}),
      },
      summary: { messageCount: nextMessages.length, latestMessage: message },
    });

    if (runId) {
      await appendHistoryEventPg(context.db, {
        runId,
        eventType: "chat.message",
        actorType: "user",
        sessionId,
        payload: {
          messageId,
          message,
          channel: "freeform-chat",
        },
      });
    }

    return json("chat-message", { sessionId, messageId, status: "recorded" });
  }
  return undefined;
}

function requireExistingParentMessage(messages: Array<{ id: string }>, parentMessageId: string): string {
  if (messages.some((message) => message.id === parentMessageId)) return parentMessageId;
  throw new Error(`parentMessageId ${parentMessageId} was not found in chat session`);
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
