import type {
  HostAdapter,
  HostChildRunResult,
  StartBackgroundChildRequest,
  StartRootSessionRequest,
} from "../../types/host.ts";

export interface OpenCodeSdk {
  sessions: {
    start(request: StartRootSessionRequest): { id: string };
    heartbeat(leaseId: string): void;
    status(sessionId: string): { status: "live" | "missing" | "unknown" };
    resumeHint(sessionId: string): string;
  };
  children: {
    start(request: StartBackgroundChildRequest): { id: string; sessionId: string };
    status(childRunId: string): { status: string };
  };
}

export class OpenCodeHostAdapter implements HostAdapter {
  private readonly sdk: OpenCodeSdk;

  constructor(sdk: OpenCodeSdk) {
    this.sdk = sdk;
  }

  startRootSession(request: StartRootSessionRequest): { root_session_id: string } {
    return { root_session_id: this.sdk.sessions.start(request).id };
  }

  recordHeartbeat(lease_id: string): { status: "recorded" } {
    this.sdk.sessions.heartbeat(lease_id);
    return { status: "recorded" };
  }

  startBackgroundChild(request: StartBackgroundChildRequest): HostChildRunResult {
    const child = this.sdk.children.start(request);
    return {
      child_run_id: child.id,
      root_session_id: request.root_session_id,
      session_id: child.sessionId,
      status: "running",
      agent: request.role.agent,
      load_skills: request.role.load_skills,
    };
  }

  readRootStatus(root_session_id: string): { status: "live" | "missing" | "unknown" } {
    return this.sdk.sessions.status(root_session_id);
  }

  readChildStatus(child_run_id: string): { status: string } {
    return this.sdk.children.status(child_run_id);
  }

  resumeHint(root_session_id: string): string {
    return this.sdk.sessions.resumeHint(root_session_id);
  }

  capabilities(): string[] {
    return ["sdk", "root-session", "background-child", "heartbeat"];
  }
}
