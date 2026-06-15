export type SouthstarEnv = {
  databaseUrl: string;
  serverUrl: string;
  dockerRequired: boolean;
  piPlannerEndpoint?: string;
  codexCliPath: string;
};

export function loadSouthstarEnv(input: Record<string, string | undefined> = process.env): SouthstarEnv {
  return {
    databaseUrl: input.SOUTHSTAR_DB ?? ".southstar/southstar-v2.sqlite3",
    serverUrl: input.SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3100",
    dockerRequired: input.SOUTHSTAR_REQUIRE_DOCKER !== "0",
    piPlannerEndpoint: input.PI_PLANNER_ENDPOINT,
    codexCliPath: input.CODEX_CLI_PATH ?? "codex",
  };
}
