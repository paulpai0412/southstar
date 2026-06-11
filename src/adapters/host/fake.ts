import type {
  HostAdapter,
  HostChildRunResult,
  StartBackgroundChildRequest,
  StartRootSessionRequest,
} from "../../types/host.ts";

export class FakeHostAdapter implements HostAdapter {
  private childSequence = 0;

  startRootSession(request: StartRootSessionRequest): { root_session_id: string } {
    return { root_session_id: `fake-root-${request.issue_id}-${request.role_name}` };
  }

  recordHeartbeat(_lease_id: string): { status: "recorded" } {
    return { status: "recorded" };
  }

  startBackgroundChild(request: StartBackgroundChildRequest): HostChildRunResult {
    this.childSequence += 1;
    return {
      child_run_id: `fake-child-${this.childSequence}`,
      root_session_id: request.root_session_id,
      session_id: `fake-child-session-${this.childSequence}`,
      status: "running",
      agent: request.role.agent,
      load_skills: request.role.load_skills,
    };
  }

  readRootStatus(_root_session_id: string): { status: "live" } {
    return { status: "live" };
  }

  readChildStatus(_child_run_id: string): { status: string } {
    return { status: "running" };
  }

  resumeHint(root_session_id: string): string {
    return `resume ${root_session_id}`;
  }

  capabilities(): string[] {
    return ["root-session", "background-child", "heartbeat"];
  }
}
