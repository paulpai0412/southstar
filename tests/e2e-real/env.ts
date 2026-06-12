import { execFileSync } from "node:child_process";

export type RealE2EEnv = {
  torkBaseUrl: string;
  southstarDb: string;
  piPlannerEndpoint?: string;
  piHarnessEndpoint?: string;
  piPlannerMode: "http" | "sdk";
  piHarnessMode: "http" | "sdk";
  workspaceRoot: string;
};

export type RealE2EProbes = {
  dockerVersion(): Promise<void>;
  torkHealth(baseUrl: string): Promise<void>;
  piConfig(env: RealE2EEnv): Promise<void>;
};

export async function loadRealE2EEnv(
  input: Record<string, string | undefined> = process.env,
  probes: RealE2EProbes = defaultProbes,
): Promise<RealE2EEnv> {
  const missing: string[] = [];
  if (!input.TORK_BASE_URL) missing.push("TORK_BASE_URL");
  if (!input.SOUTHSTAR_DB) missing.push("SOUTHSTAR_DB");
  if (missing.length > 0) {
    throw new Error(`Real E2E missing required env: ${missing.join(", ")}`);
  }
  const torkBaseUrl = input.TORK_BASE_URL as string;
  const southstarDb = input.SOUTHSTAR_DB as string;
  const piPlannerEndpoint = input.PI_PLANNER_ENDPOINT as string;
  const piHarnessEndpoint = input.PI_HARNESS_ENDPOINT as string;

  const env = {
    torkBaseUrl,
    southstarDb,
    piPlannerEndpoint: input.PI_PLANNER_ENDPOINT,
    piHarnessEndpoint: input.PI_HARNESS_ENDPOINT,
    piPlannerMode: input.PI_PLANNER_ENDPOINT ? "http" as const : "sdk" as const,
    piHarnessMode: input.PI_HARNESS_ENDPOINT ? "http" as const : "sdk" as const,
    workspaceRoot: input.SOUTHSTAR_E2E_WORKSPACE ?? "/tmp/southstar-real-e2e",
  };
  await probes.dockerVersion();
  await probes.torkHealth(env.torkBaseUrl);
  await probes.piConfig(env);
  return env;
}

const defaultProbes: RealE2EProbes = {
  async dockerVersion() {
    execFileSync("docker", ["version"], { stdio: "pipe" });
  },
  async torkHealth(baseUrl: string) {
    const root = baseUrl.replace(/\/$/, "");
    for (const path of ["/health", "/api/v1/health"]) {
      let response: Response;
      try {
        response = await fetch(`${root}${path}`);
      } catch (error) {
        throw new Error(`Tork health failed: cannot connect to ${root}${path}: ${(error as Error).message}`);
      }
      if (response.ok) return;
      if (response.status !== 404) {
        throw new Error(`Tork health failed: ${response.status} ${await response.text()}`);
      }
    }
    throw new Error("Tork health failed: no supported health endpoint responded");
  },
  async piConfig(env: RealE2EEnv) {
    if (env.piPlannerEndpoint) {
      const plannerResponse = await fetch(env.piPlannerEndpoint, {
        method: "OPTIONS",
      });
      if (!plannerResponse.ok && plannerResponse.status !== 405) {
        throw new Error(`Pi planner endpoint probe failed: ${plannerResponse.status} ${await plannerResponse.text()}`);
      }
    }
    if (env.piHarnessEndpoint) {
      const harnessResponse = await fetch(env.piHarnessEndpoint, {
        method: "OPTIONS",
      });
      if (!harnessResponse.ok && harnessResponse.status !== 405) {
        throw new Error(`Pi harness endpoint probe failed: ${harnessResponse.status} ${await harnessResponse.text()}`);
      }
    }
    if (!env.piPlannerEndpoint || !env.piHarnessEndpoint) {
      await import("@earendil-works/pi-coding-agent");
    }
  },
};
