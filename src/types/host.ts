/* c8 ignore start */
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
import type { RoleDefinition } from "./workflow.ts";

export interface StartRootSessionRequest {
  issue_id: string;
  role_name: string;
  role: RoleDefinition;
}

export interface StartBackgroundChildRequest {
  issue_id: string;
  lease_id: string;
  root_session_id: string;
  role_name: string;
  role: RoleDefinition;
}

export interface HostChildRunResult {
  child_run_id: string;
  root_session_id: string;
  session_id: string;
  status: "running" | "queued";
  agent: string;
  load_skills: string[];
  capability_report?: HostCapabilityReport;
}

export interface HostAdapter {
  startRootSession(request: StartRootSessionRequest): { root_session_id: string };
  recordHeartbeat(lease_id: string): { status: "recorded" };
  startBackgroundChild(request: StartBackgroundChildRequest): HostChildRunResult;
  readRootStatus(root_session_id: string): { status: "live" | "missing" | "unknown" };
  readChildStatus(child_run_id: string): { status: string };
  resumeHint(root_session_id: string): string;
  capabilities(): string[];
}
/* c8 ignore stop */
