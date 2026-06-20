import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { IssueVaultLeaseInput, Vault, VaultLease } from "./types.ts";

export function createPostgresVault(db: SouthstarDb): Vault {
  return {
    issueLease: (input) => issueLease(db, input),
    getLease: (resourceKey) => getLease(db, resourceKey),
  };
}

export async function issueLease(db: SouthstarDb, input: IssueVaultLeaseInput): Promise<VaultLease> {
  if (input.ttlSeconds <= 0) throw new Error("vault lease ttlSeconds must be positive");
  if (input.allowedTools.length === 0) throw new Error("vault lease must allow at least one tool");

  const id = input.id ?? `vault-lease-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  const lease: VaultLease = {
    id,
    runId: input.runId,
    sessionId: input.sessionId,
    secretRef: input.secretRef,
    allowedTools: [...input.allowedTools],
    expiresAt,
  };
  const digest = createHash("sha256").update(input.plaintextSecret).digest("hex");

  await db.tx(async (tx) => {
    await upsertRuntimeResourcePg(tx, {
      id,
      resourceType: "vault_lease",
      resourceKey: id,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: "task",
      status: "active",
      title: `Vault lease for ${input.secretRef}`,
      payload: {
        ...lease,
        secretDigest: digest,
        reason: input.reason,
      },
      summary: {
        secretRef: input.secretRef,
        allowedTools: lease.allowedTools,
        expiresAt,
      },
      expiresAt,
    });
    await tx.query(
      `insert into southstar.secure_blobs (
        id, resource_id, provider, key_id, ciphertext_blob, metadata_json, created_at, rotated_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, now(), null)
      on conflict (id) do update set
        ciphertext_blob = excluded.ciphertext_blob,
        metadata_json = excluded.metadata_json`,
      [
        `secure-${randomUUID()}`,
        id,
        "dev-sha256-digest",
        input.secretRef,
        Buffer.from(digest),
        JSON.stringify({ storage: "sha256-digest-only", secretRef: input.secretRef }),
      ],
    );
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: "vault_lease.issued",
      actorType: "orchestrator",
      payload: {
        leaseId: id,
        secretRef: input.secretRef,
        allowedTools: lease.allowedTools,
        expiresAt,
      },
    });
  });

  return lease;
}

export async function getLease(db: SouthstarDb, resourceKey: string): Promise<VaultLease | null> {
  const resource = await getResourceByKeyPg(db, "vault_lease", resourceKey);
  if (!resource || resource.status !== "active" || !resource.runId || !resource.sessionId) return null;
  const payload = resource.payload as Partial<VaultLease>;
  if (payload.id !== resource.id || !payload.secretRef || !Array.isArray(payload.allowedTools) || !payload.expiresAt) return null;
  return {
    id: resource.id,
    runId: resource.runId,
    sessionId: resource.sessionId,
    secretRef: payload.secretRef,
    allowedTools: payload.allowedTools,
    expiresAt: payload.expiresAt,
    secretDigest: typeof payload.secretDigest === "string" ? payload.secretDigest : undefined,
  };
}
