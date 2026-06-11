export interface LiveGitHubEnv {
  token: string;
  repo: string;
  projectId: string;
}

export function liveGitHubEnabled(): boolean {
  return process.env.NORTHSTAR_LIVE_GITHUB === "1";
}

export function requireLiveGitHubEnv(): LiveGitHubEnv {
  const missing = [
    ...(process.env.GITHUB_TOKEN ? [] : ["GITHUB_TOKEN"]),
    ...(process.env.NORTHSTAR_LIVE_GITHUB_REPO ? [] : ["NORTHSTAR_LIVE_GITHUB_REPO"]),
    ...(process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID ? [] : ["NORTHSTAR_LIVE_GITHUB_PROJECT_ID"]),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing GitHub live E2E configuration: ${missing.join(", ")}`);
  }
  return {
    token: process.env.GITHUB_TOKEN!,
    repo: process.env.NORTHSTAR_LIVE_GITHUB_REPO!,
    projectId: process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID!,
  };
}

export function liveSdkEnabled(name: "opencode" | "codex"): boolean {
  return process.env[name === "opencode" ? "NORTHSTAR_LIVE_OPENCODE" : "NORTHSTAR_LIVE_CODEX"] === "1";
}
