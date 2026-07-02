import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

function getOAuthProviderIds(authStorage: AuthStorage) {
  const ids = new Set<string>(authStorage.getOAuthProviders().map((p) => p.id));
  for (const providerId of authStorage.list()) {
    if (authStorage.get(providerId)?.type === "oauth") ids.add(providerId);
  }
  return ids;
}

export async function GET() {
  const authStorage = AuthStorage.create();
  const registry = ModelRegistry.create(authStorage);
  const all = registry.getAll();
  const oauthProviderIds = getOAuthProviderIds(authStorage);

  // Deduplicate by provider, skip OAuth providers and custom providers (source=models_json_key)
  const seen = new Set<string>();
  const result: {
    id: string;
    displayName: string;
    configured: boolean;
    source?: string;
    modelCount: number;
  }[] = [];

  for (const m of all) {
    if (seen.has(m.provider)) continue;
    seen.add(m.provider);
    if (oauthProviderIds.has(m.provider)) continue;
    const status = registry.getProviderAuthStatus(m.provider);
    // Skip providers whose key comes from models.json (those are custom providers)
    if (status.source === "models_json_key") continue;
    const displayName = registry.getProviderDisplayName(m.provider);
    const modelCount = all.filter((x) => x.provider === m.provider).length;
    result.push({
      id: m.provider,
      displayName,
      configured: status.configured,
      source: status.source,
      modelCount,
    });
  }

  return Response.json({ providers: result });
}
