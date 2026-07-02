import { AuthStorage } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const authStorage = AuthStorage.create();
  const providers = authStorage.getOAuthProviders();
  const knownOAuthProvider = providers.some((p) => p.id === provider);
  const storedOAuthCredential = authStorage.get(provider)?.type === "oauth";

  if (!knownOAuthProvider && !storedOAuthCredential) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  authStorage.logout(provider);
  return Response.json({ ok: true });
}
