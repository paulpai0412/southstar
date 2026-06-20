import type { HandProvider } from "./types.ts";

export type HandProviderRegistry = {
  get(providerId: string): HandProvider;
  list(): HandProvider[];
};

export function createHandProviderRegistry(providers: HandProvider[]): HandProviderRegistry {
  const byId = new Map<string, HandProvider>();
  for (const provider of providers) {
    if (byId.has(provider.providerId)) throw new Error(`duplicate hand provider registered: ${provider.providerId}`);
    byId.set(provider.providerId, provider);
  }
  return {
    get(providerId: string): HandProvider {
      const provider = byId.get(providerId);
      if (!provider) throw new Error(`hand provider not registered: ${providerId}`);
      return provider;
    },
    list(): HandProvider[] {
      return [...byId.values()];
    },
  };
}
