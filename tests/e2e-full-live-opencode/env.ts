export interface FullLiveOpenCodeEnv {
  token: string;
  repo: "paulpai0412/northstar-live-sandbox";
}

const sandboxRepo = "paulpai0412/northstar-live-sandbox";

export function fullLiveOpenCodeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NORTHSTAR_FULL_LIVE_OPENCODE === "1";
}

export function fullLiveOpenCodeLayerSelected(
  layer: "happy" | "exceptions",
  env: Record<string, string | undefined> = process.env,
): boolean {
  const selected = env.NORTHSTAR_FULL_LIVE_OPENCODE_LAYER;
  return selected === undefined || selected === "" || selected === layer;
}

export function requireFullLiveOpenCodeEnv(env: Record<string, string | undefined> = process.env): FullLiveOpenCodeEnv {
  const missing = ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing OpenCode full live E2E configuration: ${missing.join(", ")}`);
  }
  if (env.NORTHSTAR_LIVE_GITHUB_REPO !== sandboxRepo) {
    throw new Error(`NORTHSTAR_LIVE_GITHUB_REPO must be ${sandboxRepo}`);
  }
  return {
    token: env.GITHUB_TOKEN ?? "",
    repo: sandboxRepo,
  };
}
