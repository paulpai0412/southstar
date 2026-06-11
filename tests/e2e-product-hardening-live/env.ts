export interface ProductHardeningLiveEnv {
  repo: string;
  projectId: string;
  token: string;
  sdkCredentialsAvailable: boolean;
  browserBin?: string;
}

export function productHardeningLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NORTHSTAR_PRODUCT_HARDENING_LIVE === "1";
}

export function requireProductHardeningLiveEnv(env: Record<string, string | undefined> = process.env): ProductHardeningLiveEnv {
  const sdkCredentialsAvailable = hasSdkCredentials(env);
  const missing = [
    ...requiredEnvKeys.filter((key) => !env[key]),
    ...(sdkCredentialsAvailable ? [] : ["SDK credentials"]),
  ];

  if (missing.length > 0) {
    throw new Error([
      `Missing product hardening live E2E configuration: ${missing.join(", ")}`,
      "Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 with GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO, NORTHSTAR_LIVE_GITHUB_PROJECT_ID,",
      "and SDK credentials via Codex/OpenCode local auth or OPENAI_API_KEY/CODEX_API_KEY/OPENCODE_API_KEY.",
      "Set NORTHSTAR_PRODUCT_HARDENING_SDK_READY=1 only when local SDK auth is already configured and safe to use.",
    ].join(" "));
  }

  return {
    repo: env.NORTHSTAR_LIVE_GITHUB_REPO ?? "",
    projectId: env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID ?? "",
    token: env.GITHUB_TOKEN ?? "",
    sdkCredentialsAvailable,
    browserBin: env.NORTHSTAR_BROWSER_BIN,
  };
}

const requiredEnvKeys = [
  "GITHUB_TOKEN",
  "NORTHSTAR_LIVE_GITHUB_REPO",
  "NORTHSTAR_LIVE_GITHUB_PROJECT_ID",
] as const;

function hasSdkCredentials(env: Record<string, string | undefined>): boolean {
  return [
    "NORTHSTAR_PRODUCT_HARDENING_SDK_READY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENCODE_API_KEY",
  ].some((key) => Boolean(env[key]));
}
