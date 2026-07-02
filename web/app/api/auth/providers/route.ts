import { AuthStorage } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

const EXCLUDED = new Set(["anthropic"]);
const DISPLAY_NAMES: Record<string, string> = {
  "openai-codex": "ChatGPT Plus/Pro",
  "github-copilot": "GitHub Copilot",
};

function humanizeProviderId(id: string) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function GET() {
  const authStorage = AuthStorage.create();
  const knownProviders = authStorage.getOAuthProviders();
  const providersById = new Map<string, { id: string; name: string; usesCallbackServer: boolean; loggedIn: boolean }>();

  for (const provider of knownProviders) {
    if (EXCLUDED.has(provider.id)) continue;
    providersById.set(provider.id, {
      id: provider.id,
      name: DISPLAY_NAMES[provider.id] ?? provider.name,
      usesCallbackServer: provider.usesCallbackServer ?? false,
      loggedIn: authStorage.has(provider.id),
    });
  }

  // Also expose OAuth credentials already persisted in auth.json even if the current
  // process does not have that OAuth provider registered.
  for (const providerId of authStorage.list()) {
    if (EXCLUDED.has(providerId)) continue;
    if (providersById.has(providerId)) continue;
    if (authStorage.get(providerId)?.type !== "oauth") continue;

    providersById.set(providerId, {
      id: providerId,
      name: DISPLAY_NAMES[providerId] ?? humanizeProviderId(providerId),
      usesCallbackServer: false,
      loggedIn: true,
    });
  }

  return Response.json({ providers: Array.from(providersById.values()) });
}
