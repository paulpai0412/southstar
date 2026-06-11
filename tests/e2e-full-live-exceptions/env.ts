export interface FullLiveExceptionEnv {
  token: string;
  repo: "paulpai0412/northstar-live-sandbox";
  project_id?: string;
}

export type FullLiveExceptionLayer = "github" | "codex" | "recovery";

const sandboxRepo = "paulpai0412/northstar-live-sandbox";

export function fullLiveExceptionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NORTHSTAR_FULL_LIVE_EXCEPTIONS === "1";
}

export function fullLiveExceptionLayerSelected(
  layer: FullLiveExceptionLayer,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const selected = env.NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER;
  return selected === undefined || selected === "" || selected === layer;
}

export function requireFullLiveExceptionEnv(env: Record<string, string | undefined> = process.env): FullLiveExceptionEnv {
  const missing = ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing full live exception E2E configuration: ${missing.join(", ")}`);
  }
  if (env.NORTHSTAR_LIVE_GITHUB_REPO !== sandboxRepo) {
    throw new Error(`NORTHSTAR_LIVE_GITHUB_REPO must be ${sandboxRepo}`);
  }
  return {
    token: env.GITHUB_TOKEN ?? "",
    repo: sandboxRepo,
    project_id: env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID,
  };
}
