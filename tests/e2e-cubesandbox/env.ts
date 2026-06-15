import { loadConfig } from "../../src/config/load-config.ts";

export type CubeSandboxRealE2EEnv = {
  configPath: string;
  callbackHost: string;
  workspaceRoot: string;
  evidenceDir: string;
};

export function loadCubeSandboxRealE2EEnv(input: Record<string, string | undefined> = process.env): CubeSandboxRealE2EEnv {
  if (input.SOUTHSTAR_CUBESANDBOX_E2E !== "1") {
    throw new Error("CubeSandbox real E2E requires SOUTHSTAR_CUBESANDBOX_E2E=1");
  }
  const configPath = input.SOUTHSTAR_CONFIG;
  if (!configPath) {
    throw new Error("CubeSandbox real E2E requires SOUTHSTAR_CONFIG pointing to .southstar.yaml");
  }
  const config = loadConfig(configPath);
  if (config.executor.provider !== "cubesandbox") {
    throw new Error("CubeSandbox real E2E config must set executor.provider=cubesandbox");
  }
  return {
    configPath,
    callbackHost: input.SOUTHSTAR_CALLBACK_HOST ?? "127.0.0.1",
    workspaceRoot: input.SOUTHSTAR_E2E_WORKSPACE ?? "/tmp/southstar-cubesandbox-e2e",
    evidenceDir: input.SOUTHSTAR_E2E_EVIDENCE_DIR ?? ".southstar/evidence/cubesandbox",
  };
}
