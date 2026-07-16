import { NextResponse } from "next/server";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { buildWorkflowV2Url, workflowV2Capabilities } from "@/lib/workflow/v2-api";
import {
  filterSessionsByKind,
  listAllSessions,
  listRecentSessionsByKind,
  listSessionsForCwd,
  type SessionKind,
} from "@/lib/session-reader";

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope");
    const requestedKind = sessionKindFromQuery(url.searchParams.get("kind"));
    const limit = limitFromQuery(url.searchParams.get("limit"));
    const compact = url.searchParams.get("compact") === "1";
    const cwd = normalizeCwd(url.searchParams.get("cwd") || process.cwd());
    const sessions = scope === "all" && limit
      ? await listRecentSessionsByKind(requestedKind, limit)
      : scope === "all"
        ? await listAllSessions()
        : await listSessionsForCwd(cwd);
    const filtered = filterSessionsByKind(sessions, requestedKind);
    const limited = limit ? filtered.slice(0, limit) : filtered;
    const enriched = await enrichSessionsWithGoalJourneys(limited);
    return NextResponse.json({ sessions: compact ? enriched.map(compactSession) : enriched });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

async function enrichSessionsWithGoalJourneys<T extends { id: string }>(sessions: T[]): Promise<T[]> {
  if (sessions.length === 0 || !workflowV2Capabilities().v2Backend) return sessions;
  try {
    const upstream = buildWorkflowV2Url("/api/v2/ui/goal-journeys");
    upstream.searchParams.set("sessionIds", sessions.map((session) => session.id).join(","));
    const response = await fetch(upstream, { cache: "no-store" });
    if (!response.ok) return sessions;
    const payload = await response.json() as { result?: { journeys?: Record<string, unknown> }; journeys?: Record<string, unknown> };
    const journeys = payload.result?.journeys ?? payload.journeys ?? {};
    return sessions.map((session) => {
      const journey = journeys[session.id];
      return journey && typeof journey === "object" ? { ...session, journey } as T : session;
    });
  } catch {
    return sessions;
  }
}

function sessionKindFromQuery(value: string | null): SessionKind {
  if (value === "workflow" || value === "library") return value;
  return "chat";
}

function limitFromQuery(value: string | null): number | null {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : null;
}

function compactSession<T extends { firstMessage?: string }>(session: T): T {
  const firstMessage = session.firstMessage;
  if (!firstMessage || firstMessage.length <= 180) return session;
  return { ...session, firstMessage: `${firstMessage.slice(0, 180)}...` };
}
