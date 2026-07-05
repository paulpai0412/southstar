export type SouthstarEnv = {
  databaseUrl: string;
  testAdminDatabaseUrl: string;
  torkBaseUrl: string;
  torkWebUrl: string;
  serverUrl: string;
  containerCallbackBaseUrl?: string;
  dockerRequired: boolean;
  piPlannerEndpoint?: string;
  piPlannerTimeoutMs: number;
  codexCliPath: string;
};

export function loadSouthstarEnv(input: Record<string, string | undefined> = process.env): SouthstarEnv {
  const databaseUrl = input.SOUTHSTAR_DATABASE_URL ?? input.SOUTHSTAR_DB ?? "postgres://postgres:postgres@127.0.0.1:55432/southstar";
  return {
    databaseUrl,
    testAdminDatabaseUrl: input.SOUTHSTAR_TEST_ADMIN_DATABASE_URL ?? adminDatabaseUrl(databaseUrl),
    torkBaseUrl: input.TORK_BASE_URL ?? "http://127.0.0.1:8000",
    torkWebUrl: input.TORK_WEB_URL ?? "http://127.0.0.1:8100",
    serverUrl: input.SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3100",
    containerCallbackBaseUrl: input.SOUTHSTAR_CONTAINER_CALLBACK_BASE_URL,
    dockerRequired: input.SOUTHSTAR_REQUIRE_DOCKER !== "0",
    piPlannerEndpoint: input.PI_PLANNER_ENDPOINT,
    piPlannerTimeoutMs: positiveInteger(input.SOUTHSTAR_PI_PLANNER_TIMEOUT_MS) ?? 180_000,
    codexCliPath: input.CODEX_CLI_PATH ?? "codex",
  };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function adminDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    parsed.pathname = "/postgres";
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}
