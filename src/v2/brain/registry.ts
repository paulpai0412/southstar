import type { BrainProvider } from "./types.ts";

export type BrainProviderRegistry = {
  get(providerId: string): BrainProvider;
  list(): BrainProvider[];
};

export function createBrainProviderRegistry(providers: BrainProvider[]): BrainProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
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
