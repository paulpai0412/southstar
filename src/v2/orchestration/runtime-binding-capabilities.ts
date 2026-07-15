export type RuntimeBindingCapabilities = {
  providers?: string[];
  models?: string[];
  harnesses?: string[];
  executionEngines?: string[];
  images?: string[];
};

/** Runtime support is host configuration, not a composer allowlist. */
export function runtimeBindingCapabilitiesFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeBindingCapabilities | undefined {
  const capabilities: RuntimeBindingCapabilities = {
    ...(csv(env.SOUTHSTAR_AGENT_PROVIDERS) ? { providers: csv(env.SOUTHSTAR_AGENT_PROVIDERS) } : {}),
    ...(csv(env.SOUTHSTAR_AGENT_MODELS) ? { models: csv(env.SOUTHSTAR_AGENT_MODELS) } : {}),
    ...(csv(env.SOUTHSTAR_AGENT_HARNESSES) ? { harnesses: csv(env.SOUTHSTAR_AGENT_HARNESSES) } : {}),
    ...(csv(env.SOUTHSTAR_EXECUTION_ENGINES) ? { executionEngines: csv(env.SOUTHSTAR_EXECUTION_ENGINES) } : {}),
    ...(csv(env.SOUTHSTAR_AGENT_IMAGES) ? { images: csv(env.SOUTHSTAR_AGENT_IMAGES) } : {}),
  };
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  return values.length > 0 ? values : undefined;
}
