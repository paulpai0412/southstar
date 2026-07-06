import { NextResponse } from "next/server";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { filterSessionsByKind, listAllSessions, listSessionsForCwd, type SessionKind } from "@/lib/session-reader";

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
    const cwd = normalizeCwd(url.searchParams.get("cwd") || process.cwd());
    const sessions = scope === "all" ? await listAllSessions() : await listSessionsForCwd(cwd);
    return NextResponse.json({ sessions: filterSessionsByKind(sessions, requestedKind) });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

function sessionKindFromQuery(value: string | null): SessionKind {
  return value === "workflow" ? "workflow" : "chat";
}
