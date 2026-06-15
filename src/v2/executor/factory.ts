import type { RuntimeConfig } from "../../config/schema.ts";
import type { ExecutorProvider } from "./provider.ts";
import { TorkClient } from "./tork-client.ts";
import { TorkExecutorProvider } from "./tork-provider.ts";
import { CubeSandboxExecutorProvider } from "./cubesandbox/provider.ts";
import { createE2bCompatibleCubeSandboxSdkClient } from "./cubesandbox/sdk-client.ts";

export type ExecutorProviderFactoryDependencies = {
  resolveCredential(ref: string): string;
};

export function createExecutorProviderFromConfig(
  config: RuntimeConfig,
  dependencies: ExecutorProviderFactoryDependencies,
): ExecutorProvider {
  if (config.executor.provider === "tork") {
    if (!config.executor.tork) {
      throw new Error("active tork executor config missing");
    }
    return new TorkExecutorProvider({
      torkClient: new TorkClient({
        baseUrl: config.executor.tork.baseUrl,
        submitPath: config.executor.tork.submitPath,
      }),
      envelopeBasePath: "/southstar-runs",
    });
  }

  if (!config.executor.cubesandbox) {
    throw new Error("active cubesandbox executor config missing");
  }

  return new CubeSandboxExecutorProvider({
    config: config.executor.cubesandbox,
    lifecycle: config.executor.lifecycle,
    sdkClient: createE2bCompatibleCubeSandboxSdkClient({
      apiUrl: config.executor.cubesandbox.apiUrl,
      apiKey: dependencies.resolveCredential(config.executor.cubesandbox.apiKeyRef),
      sdkCallTimeoutSeconds: config.executor.lifecycle.sdkCallTimeoutSeconds,
    }),
  });
}
