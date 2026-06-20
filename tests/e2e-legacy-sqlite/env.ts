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
  southstarTaskContainersIdle(): Promise<void>;
  torkHealth(baseUrl: string): Promise<void>;
  torkQueueIdle(baseUrl: string): Promise<void>;
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
  await probes.southstarTaskContainersIdle();
  await probes.torkHealth(env.torkBaseUrl);
  await probes.torkQueueIdle(env.torkBaseUrl);
  await probes.piConfig(env);
  return env;
}

const defaultProbes: RealE2EProbes = {
  async dockerVersion() {
    execFileSync("docker", ["version"], { stdio: "pipe" });
  },
  async southstarTaskContainersIdle() {
    const output = execFileSync("docker", [
      "ps",
      "--filter",
      "ancestor=southstar/pi-agent:local",
      "--format",
      "{{.ID}} {{.Status}} {{.Names}}",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (output.length > 0) {
      throw new Error([
        "Real E2E requires no active southstar/pi-agent task containers before starting.",
        "Stop stale task containers or restart the local Tork test environment.",
        output,
      ].join("\n"));
    }
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
  async torkQueueIdle(baseUrl: string) {
    const root = baseUrl.replace(/\/$/, "");
    const response = await fetch(`${root}/jobs`);
    if (!response.ok) {
      throw new Error(`Tork queue preflight failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as {
      items?: Array<{ name?: string; state?: string; id?: string }>;
    };
    const activeSouthstarJobs = (payload.items ?? []).filter((job) => {
      const state = (job.state ?? "").toUpperCase();
      return typeof job.name === "string"
        && job.name.startsWith("run-wf-")
        && ["CREATED", "PENDING", "SCHEDULED", "RUNNING"].includes(state);
    });
    if (activeSouthstarJobs.length > 0) {
      throw new Error([
        "Tork queue contains active Southstar jobs; real E2E requires an idle shared Tork queue.",
        ...activeSouthstarJobs.map((job) => `${job.id ?? "unknown"} ${job.state ?? "unknown"} ${job.name}`),
      ].join("\n"));
    }
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
