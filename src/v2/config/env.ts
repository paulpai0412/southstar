export type SouthstarEnv = {
  databaseUrl: string;
  torkBaseUrl: string;
  dockerRequired: boolean;
  piPlannerEndpoint?: string;
  codexCliPath: string;
};

export function loadSouthstarEnv(input: Record<string, string | undefined> = process.env): SouthstarEnv {
  return {
    databaseUrl: input.SOUTHSTAR_DB ?? ".southstar/southstar-v2.sqlite3",
    torkBaseUrl: input.TORK_BASE_URL ?? "http://127.0.0.1:8000",
    dockerRequired: input.SOUTHSTAR_REQUIRE_DOCKER !== "0",
    piPlannerEndpoint: input.PI_PLANNER_ENDPOINT,
    codexCliPath: input.CODEX_CLI_PATH ?? "codex",
  };
}
