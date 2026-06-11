export interface FullLiveEnv {
  token: string;
  repo: "paulpai0412/northstar-live-sandbox";
}

const sandboxRepo = "paulpai0412/northstar-live-sandbox";

export function fullLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NORTHSTAR_FULL_LIVE === "1";
}

export function fullLiveScenarioSelected(
  scenario: "single" | "sequential" | "parallel",
  env: Record<string, string | undefined> = process.env,
): boolean {
  const selected = env.NORTHSTAR_FULL_LIVE_SCENARIO;
  return selected === undefined || selected === "" || selected === scenario;
}

export function requireFullLiveEnv(env: Record<string, string | undefined> = process.env): FullLiveEnv {
  const missing = ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing full live E2E configuration: ${missing.join(", ")}`);
  }
  if (env.NORTHSTAR_LIVE_GITHUB_REPO !== sandboxRepo) {
    throw new Error(`NORTHSTAR_LIVE_GITHUB_REPO must be ${sandboxRepo}`);
  }
  return {
    token: env.GITHUB_TOKEN ?? "",
    repo: sandboxRepo,
  };
}
