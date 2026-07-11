import type { AgentMessage, AssistantMessage } from "./types";
import type { SessionStatsInfo } from "./pi-types";
import type { WorkflowTemplatePolicyV1 } from "./workflow/types";

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export type SessionContextUsage = {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
};

export interface BuildSessionStatsInput {
  messages: AgentMessage[];
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  contextUsage?: SessionContextUsage | null;
}

export function buildSessionStats(input: BuildSessionStatsInput): SessionStatsInfo | null {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let toolCalls = 0;

  for (const msg of input.messages) {
    if (msg.role === "user") userMessages += 1;
    if (msg.role === "toolResult") toolResults += 1;
    if (msg.role !== "assistant") continue;

    assistantMessages += 1;
    const assistant = msg as AssistantMessage;
    toolCalls += assistant.content.filter((content) => content.type === "toolCall").length;

    const usage = assistant.usage;
    if (!usage) continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  }

  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  if (tokens.total === 0 && input.messages.length === 0) return null;

  return {
    sessionFile: input.sessionFile,
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: input.messages.length,
    tokens,
    cost,
    ...(input.contextUsage ? { contextUsage: input.contextUsage } : {}),
  };
}

export function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown };
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export function workflowTemplateIdFrom(template: unknown): string | null {
  if (!template || typeof template !== "object") return null;
  const id = (template as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function workflowTemplatePolicyFrom(template: unknown): WorkflowTemplatePolicyV1 {
  if (!template || typeof template !== "object") return { mode: "auto" };
  const record = template as { id?: unknown; versionRef?: unknown; headVersionId?: unknown };
  const templateRef = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
  const versionRef = typeof record.versionRef === "string" && record.versionRef.length > 0
    ? record.versionRef
    : typeof record.headVersionId === "string" && record.headVersionId.length > 0
      ? record.headVersionId
      : undefined;
  return templateRef && versionRef ? { mode: "prefer", templateRef, versionRef } : { mode: "auto" };
}

export function latestWorkflowDraftId(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const block = message.content[j];
      if (block.type !== "workflowDag") continue;
      const draftId = isPlannerDraftId(block.dag.draftId)
        ? block.dag.draftId
        : isPlannerDraftId(block.dag.id)
          ? block.dag.id
          : null;
      if (draftId) return draftId;
    }
  }
  return null;
}

function isPlannerDraftId(value: unknown): value is string {
  return typeof value === "string" && /^draft-/.test(value);
}
