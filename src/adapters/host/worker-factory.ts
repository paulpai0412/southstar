import { isProductionHostName, type ProductionHostName } from "./capabilities.ts";
import type { SoftwareDevWorker } from "../../orchestrator/software-dev-driver.ts";

export class HostWorkerFactory {
  readonly input: {
    defaultHost: ProductionHostName;
    roleOverrides: Record<string, Record<string, unknown>>;
    codexWorker: () => SoftwareDevWorker;
    opencodeWorker: () => SoftwareDevWorker;
    piWorker?: () => SoftwareDevWorker;
  };

  constructor(input: {
    defaultHost: ProductionHostName;
    roleOverrides: Record<string, Record<string, unknown>>;
    codexWorker: () => SoftwareDevWorker;
    opencodeWorker: () => SoftwareDevWorker;
    piWorker?: () => SoftwareDevWorker;
  }) {
    this.input = input;
  }

  resolveHostForRole(roleName: string): ProductionHostName {
    const override = this.input.roleOverrides[roleName]?.host_adapter;
    const host = typeof override === "string" ? override : this.input.defaultHost;
    if (!isProductionHostName(host)) {
      throw new Error(`HOST_ADAPTER_UNKNOWN: ${host}`);
    }
    return host;
  }

  workerForRole(roleName: string): SoftwareDevWorker {
    const host = this.resolveHostForRole(roleName);
    if (host === "pi") {
      if (this.input.piWorker) return this.input.piWorker();
      throw new Error("HOST_ADAPTER_NOT_CONFIGURED: pi worker is not configured");
    }
    if (host === "opencode") return this.input.opencodeWorker();
    return this.input.codexWorker();
  }
}
