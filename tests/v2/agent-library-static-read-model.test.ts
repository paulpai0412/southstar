import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentLibraryReadModelPg } from "../../src/v2/read-models/agent-library.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("agent library static catalog includes policy and context sections", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const model = await buildAgentLibraryReadModelPg(db, { domain: "software" });

    assert.ok(Array.isArray((model as any).contextPolicies));
    assert.ok((model as any).contextPolicies.some((policy: { id: string }) => policy.id === "software-context-default"));
    assert.ok(Array.isArray((model as any).sessionPolicies));
    assert.ok((model as any).sessionPolicies.some((policy: { id: string }) => policy.id === "software-session-default"));
    assert.ok(Array.isArray((model as any).memoryPolicies));
    assert.ok((model as any).memoryPolicies.some((policy: { id: string }) => policy.id === "software-memory-default"));
    assert.ok(Array.isArray((model as any).workspacePolicies));
    assert.ok((model as any).workspacePolicies.some((policy: { id: string }) => policy.id === "software-git-workspace"));
    assert.ok(Array.isArray((model as any).vaultLeasePolicies));
    assert.ok((model as any).vaultLeasePolicies.some((policy: {
      id: string;
      displayName: string;
      leaseTtlSeconds: number;
      mountMode: string;
      allowedToolRefs: string[];
      auditRequired: boolean;
    }) =>
      policy.id === "vault.github-write-token"
      && policy.displayName === "GitHub Write Token Vault Lease"
      && policy.leaseTtlSeconds === 900
      && policy.mountMode === "proxy-only"
      && policy.allowedToolRefs.includes("tool.shell-command")
      && policy.auditRequired === true
    ));
  } finally {
    await db.close();
  }
});
