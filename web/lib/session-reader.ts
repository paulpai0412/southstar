import { SessionManager, buildSessionContext as piBuildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { open, readdir, stat } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { tmpdir } from "os";
import type {
  AgentMessage,
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionContext,
  SessionTreeNode,
  AssistantMessage,
} from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { classifySessionKindFromEntries, sessionMetadataFromEntries, type SessionKind } from "./session-kind";
import { buildWorkflowCompositionPlanDisplay } from "./workflow/composition-plan-dag";
import { isWorkflowUiCheckpointMessage, restorePersistedWorkflowUiMessage } from "./workflow/session-message";
import { slimMessageForUi, slimSessionTreeForUi } from "./session-slimming";
export { filterSessionsByKind, SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE, type SessionKind } from "./session-kind";
export { slimSessionTreeForUi } from "./session-slimming";

export { getAgentDir };

const SESSION_SUMMARY_BYTES = 64 * 1024;
export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

function toSessionInfo(piSessions: PiSessionInfo[]): SessionInfo[] {
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  const cache = getPathCache();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    const metadata = sessionMetadataFromEntries(safeSessionKindEntries(s.path));
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      kind: classifySessionKindForSession(s.cwd, safeSessionKindEntries(s.path)),
      ...(metadata?.visibility ? { visibility: metadata.visibility } : {}),
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
    };
  });
}

function safeSessionKindEntries(path: string): SessionEntry[] {
  try {
    const entries = SessionManager.open(path).getEntries() as unknown as SessionEntry[];
    return entries.filter((entry) => entry.type === "custom" || entry.type === "message");
  } catch {
    return [];
  }
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  return toSessionInfo(await SessionManager.listAll());
}

export async function listSessionsForCwd(cwd: string): Promise<SessionInfo[]> {
  return toSessionInfo(await SessionManager.list(cwd));
}

export async function listRecentSessionsByKind(kind: SessionKind, limit: number): Promise<SessionInfo[]> {
  const candidates = await listSessionFileCandidates(getSessionsDir());
  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);

  const sessions: SessionInfo[] = [];
  const cache = getPathCache();
  for (const candidate of candidates) {
    const session = await readSessionInfoCandidate(candidate.path, candidate.modifiedMs);
    if (!session || (session.kind ?? "chat") !== kind) continue;
    cache.set(session.id, session.path);
    sessions.push(session);
    if (sessions.length >= limit) break;
  }

  return sessions;
}

async function listSessionFileCandidates(dir: string): Promise<Array<{ path: string; modifiedMs: number }>> {
  const candidates: Array<{ path: string; modifiedMs: number }> = [];
  await collectSessionFileCandidates(dir, candidates);
  return candidates;
}

async function collectSessionFileCandidates(dir: string, candidates: Array<{ path: string; modifiedMs: number }>): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(dirents.map(async (dirent) => {
    const absolutePath = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await collectSessionFileCandidates(absolutePath, candidates);
      return;
    }
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) return;
    try {
      const stats = await stat(absolutePath);
      candidates.push({ path: absolutePath, modifiedMs: stats.mtimeMs });
    } catch {
      // Ignore files that disappear while the session directory is being read.
    }
  }));
}

async function readSessionInfoCandidate(filePath: string, modifiedMs: number): Promise<SessionInfo | null> {
  const fileEntries = await readSessionSummaryEntries(filePath);
  if (!fileEntries) return null;

  const header = fileEntries.find(isSessionHeader);
  if (!header) return null;
  const entries = fileEntries.filter(isSessionEntry);
  const messages = entries.filter((entry) => entry.type === "message");
  const firstMessage = messages.map(messageSummaryText).find(Boolean) ?? "(no messages)";
  const name = [...entries].reverse().find(isSessionInfoEntry)?.name;
  const lastEntry = entries[entries.length - 1];
  const metadata = sessionMetadataFromEntries(entries);

  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd,
    kind: classifySessionKindForSession(header.cwd, entries),
    ...(metadata?.visibility ? { visibility: metadata.visibility } : {}),
    name,
    created: header.timestamp,
    modified: lastEntry?.timestamp ?? new Date(modifiedMs).toISOString(),
    messageCount: messages.length,
    firstMessage,
  };
}

async function readSessionSummaryEntries(filePath: string): Promise<FileEntry[] | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    const text = size <= SESSION_SUMMARY_BYTES * 2
      ? await readFileSlice(handle, 0, size)
      : `${await readFileSlice(handle, 0, SESSION_SUMMARY_BYTES)}\n${await readFileSlice(handle, size - SESSION_SUMMARY_BYTES, SESSION_SUMMARY_BYTES)}`;
    const entries: FileEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { type?: unknown };
        if (typeof entry.type === "string") entries.push(entry as FileEntry);
      } catch {
        // Tail slices can start or end mid-JSON line.
      }
    }
    return entries;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readFileSlice(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<string> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

export function classifySessionKindForSession(cwd: string, entries: SessionEntry[]): SessionKind {
  if (isLibraryImportCwd(cwd)) return "library";
  return classifySessionKindFromEntries(entries);
}

function isLibraryImportCwd(cwd: string): boolean {
  const root = resolve(process.env.SOUTHSTAR_LIBRARY_IMPORT_ROOT ?? join(tmpdir(), "southstar-library-imports"));
  const child = resolve(cwd);
  const path = relative(root, child);
  return path === "" || (!!path && !path.startsWith("..") && !isAbsolute(path));
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
  return entry.type === "session";
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function isSessionInfoEntry(entry: SessionEntry): entry is SessionEntry & { type: "session_info"; name?: string } {
  return entry.type === "session_info";
}

function messageSummaryText(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") return "";
  return contentSummaryText(message.content);
}

function contentSummaryText(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  const textBlocks: string[] = [];
  for (const block of content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      textBlocks.push(block.text);
    }
  }
  return textBlocks.join("\n");
}

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  const direct = await findSessionPathById(getSessionsDir(), sessionId);
  if (direct) {
    getPathCache().set(sessionId, direct);
    return direct;
  }

  // Cache miss fallback: keep the old broad scan for unusual session filenames.
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

async function findSessionPathById(dir: string, sessionId: string): Promise<string | null> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (dirent.name.endsWith(`${sessionId}.jsonl`)) return join(dir, dirent.name);
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const found = await findSessionPathById(join(dir, dirent.name), sessionId);
    if (found) return found;
  }

  return null;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const labelsById = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "label") {
      const l = entry as { type: "label"; targetId: string; label?: string };
      if (l.label) labelsById.set(l.targetId, l.label);
      else labelsById.delete(l.targetId);
    }
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [], label: labelsById.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    if (!entry.parentId) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
    stack.push(...node.children);
  }
  return roots;
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Find the last compaction on path (mirrors pi's buildSessionContext logic)
  let compactionId: string | undefined;
  let firstKeptEntryId: string | undefined;
  for (const e of path) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = (e as { firstKeptEntryId: string }).firstKeptEntryId;
    }
  }

  const contextEntryIds: string[] = [];
  if (compactionId) {
    // The first message in piCtx.messages is the synthetic compaction summary — map to compaction entry id
    contextEntryIds.push(compactionId);
    const compactionIdx = path.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? path.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (isContextMessageEntry(path[i])) contextEntryIds.push(path[i].id);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (isContextMessageEntry(path[i])) contextEntryIds.push(path[i].id);
    }
  } else {
    for (const e of path) {
      if (isContextMessageEntry(e)) contextEntryIds.push(e.id);
    }
  }

  // pi injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const contextMessages = (piCtx.messages as AssistantMessage[]).map((msg) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return slimMessageForUi({
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      });
    }
    if (raw.role === "branchSummary") {
      return slimMessageForUi({
        role: "user" as const,
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      });
    }
    const restoredMessage = restorePersistedWorkflowUiMessage(msg);
    return slimMessageForUi(renderWorkflowComposerMessage(normalizeToolCalls(restoredMessage)));
  });

  const display = filterDisplayMessages(contextMessages, contextEntryIds);

  return {
    messages: display.messages,
    entryIds: display.entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

function renderWorkflowComposerMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  if (message.content.some((block) => block.type === "workflowDag")) return message;

  let dag: NonNullable<ReturnType<typeof buildWorkflowCompositionPlanDisplay>>["dag"] | null = null;
  const content = message.content.map((block) => {
    if (dag || block.type !== "text") return block;
    const display = buildWorkflowCompositionPlanDisplay(block.text);
    if (!display) return block;
    dag = display.dag;
    return { ...block, text: display.formattedText };
  });

  if (!dag) return message;
  return {
    ...message,
    content: [
      ...content,
      { type: "workflowDag", dag },
    ],
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}

function isContextMessageEntry(entry: SessionEntry): boolean {
  return entry.type === "message" || entry.type === "custom_message" || (entry.type === "branch_summary" && !!entry.summary);
}

function filterDisplayMessages(messages: AgentMessage[], entryIds: string[]): Pick<SessionContext, "messages" | "entryIds"> {
  const displayMessages: AgentMessage[] = [];
  const displayEntryIds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (isWorkflowUiCheckpointMessage(msg)) continue;

    displayMessages.push(msg);
    displayEntryIds.push(entryIds[i] ?? "");
  }

  return {
    messages: displayMessages,
    entryIds: displayEntryIds,
  };
}
