import { existsSync } from "node:fs";

export function piAgentRuntimeEnv(): Record<string, string> {
  const mount = piAgentConfigMount();
  if (!mount) return {};
  return {
    PI_CODING_AGENT_DIR: mount.target,
    PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-agent-sessions",
  };
}

export function piAgentConfigMount(): { source: string; target: string; readonly: boolean } | undefined {
  const source = process.env.SOUTHSTAR_PI_AGENT_DIR ?? "/home/timmypai/.pi/agent";
  if (!existsSync(source)) return undefined;
  return { source, target: "/southstar/pi-agent", readonly: true };
}
