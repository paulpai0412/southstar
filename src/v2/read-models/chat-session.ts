import type { SouthstarDb } from "../db/postgres.ts";

type ChatSessionInput = {
  runId?: string;
  sessionId?: string;
};

export type ChatSessionMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  parentMessageId?: string;
  createdAt?: string;
};

export type ChatSessionBranchNode = {
  id: string;
  label: string;
  role: "user" | "assistant" | "system";
  children: ChatSessionBranchNode[];
};

export type ChatSessionReadModel = {
  runId?: string;
  sessionId: string | null;
  status: string;
  messages: ChatSessionMessage[];
  branchTree: ChatSessionBranchNode[];
  activeLeafId: string | null;
};

type ResourceRow = {
  resource_key: string;
  run_id: string | null;
  session_id: string | null;
  status: string;
  payload_json: unknown;
};

export async function buildChatSessionReadModelPg(
  db: SouthstarDb,
  input: ChatSessionInput,
): Promise<ChatSessionReadModel> {
  const row = await findChatSessionResource(db, input);
  if (!row) {
    return {
      ...(input.runId ? { runId: input.runId } : {}),
      sessionId: input.sessionId ?? null,
      status: "unavailable",
      messages: [],
      branchTree: [],
      activeLeafId: null,
    };
  }
  const payload = asRecord(row.payload_json);
  const messages = normalizeMessages(payload.messages);
  const branchTree = buildBranchTree(messages);
  return {
    ...(row.run_id ? { runId: row.run_id } : input.runId ? { runId: input.runId } : {}),
    sessionId: row.session_id ?? row.resource_key,
    status: row.status,
    messages,
    branchTree,
    activeLeafId: stringValue(payload.activeLeafId) ?? lastMessageId(messages),
  };
}

async function findChatSessionResource(db: SouthstarDb, input: ChatSessionInput): Promise<ResourceRow | null> {
  if (input.sessionId) {
    return await db.maybeOne<ResourceRow>(
      `select resource_key, run_id, session_id, status, payload_json
         from southstar.runtime_resources
        where resource_type = 'chat_session'
          and (resource_key = $1 or session_id = $1)
          and ($2::text is null or run_id = $2)
        order by updated_at desc
        limit 1`,
      [input.sessionId, input.runId ?? null],
    );
  }
  if (input.runId) {
    return await db.maybeOne<ResourceRow>(
      `select resource_key, run_id, session_id, status, payload_json
         from southstar.runtime_resources
        where resource_type = 'chat_session'
          and run_id = $1
        order by updated_at desc
        limit 1`,
      [input.runId],
    );
  }
  return null;
}

function normalizeMessages(value: unknown): ChatSessionMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const row = asRecord(entry);
      const role = stringValue(row.role);
      const text = stringValue(row.text ?? row.content);
      if ((role !== "user" && role !== "assistant" && role !== "system") || !text) return null;
      return {
        id: stringValue(row.id) ?? `message-${index + 1}`,
        role,
        text,
        ...(stringValue(row.parentMessageId) ? { parentMessageId: stringValue(row.parentMessageId) } : {}),
        ...(stringValue(row.createdAt ?? row.timestamp) ? { createdAt: stringValue(row.createdAt ?? row.timestamp) } : {}),
      };
    })
    .filter((message): message is ChatSessionMessage => message !== null);
}

function buildBranchTree(messages: ChatSessionMessage[]): ChatSessionBranchNode[] {
  const byId = new Map<string, ChatSessionBranchNode>();
  for (const message of messages) {
    byId.set(message.id, {
      id: message.id,
      label: message.text,
      role: message.role,
      children: [],
    });
  }
  const roots: ChatSessionBranchNode[] = [];
  for (const message of messages) {
    const node = byId.get(message.id);
    if (!node) continue;
    const parent = message.parentMessageId ? byId.get(message.parentMessageId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function lastMessageId(messages: ChatSessionMessage[]): string | null {
  return messages.at(-1)?.id ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
