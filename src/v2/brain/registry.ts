import type { BrainProvider } from "./types.ts";

export type BrainProviderRegistry = {
  get(providerId: string): BrainProvider;
  list(): BrainProvider[];
};

export function createBrainProviderRegistry(providers: BrainProvider[]): BrainProviderRegistry {
  const byId = new Map<string, BrainProvider>();
  for (const provider of providers) {
    if (byId.has(provider.providerId)) throw new Error(`duplicate brain provider registered: ${provider.providerId}`);
    byId.set(provider.providerId, provider);
  }
  return {
    get(providerId: string): BrainProvider {
      const provider = byId.get(providerId);
      if (!provider) throw new Error(`brain provider not registered: ${providerId}`);
      return provider;
    },
    list(): BrainProvider[] {
      return [...byId.values()];
    },
  };
}
