import assert from "node:assert/strict";
import test from "node:test";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesFrom,
  findLibraryEdgesTo,
  findLibraryObjectByKey,
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("library graph store upserts objects, upserts edges, and queries direct neighbors", async () => {
  const db = await createTestPostgresDb();
  try {
    const first = await upsertLibraryObject(db, {
      objectKey: "instruction.software-checker",
      objectKind: "instruction_template",
      status: "draft",
      headVersionId: "instruction.software-checker@v1",
      state: { scope: "software", title: "Checker Instruction v1" },
    });
    assert.equal(first.status, "draft");

    const second = await upsertLibraryObject(db, {
      objectKey: "instruction.software-checker",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.software-checker@v2",
      state: { scope: "software", title: "Checker Instruction v2" },
    });
    assert.equal(second.id, first.id);
    assert.equal(second.status, "approved");
    assert.equal(second.headVersionId, "instruction.software-checker@v2");

    await upsertLibraryObject(db, {
      objectKey: "instruction.software-checker-draft",
      objectKind: "instruction_template",
      status: "draft",
      headVersionId: "instruction.software-checker-draft@v1",
      state: { scope: "software", title: "Draft Instruction" },
    });
    await upsertLibraryObject(db, {
      objectKey: "profile.software-checker-codex",
      objectKind: "agent_profile",
      status: "approved",
      headVersionId: "profile.software-checker-codex@v1",
      state: { scope: "software", displayName: "Software Checker (Codex)" },
    });

    const approvedInstructions = await findApprovedLibraryObjectsByKind(db, "instruction_template", "software");
    assert.deepEqual(approvedInstructions.map((row) => row.objectKey), ["instruction.software-checker"]);

    const found = await findLibraryObjectByKey(db, "instruction.software-checker");
    assert.equal(found?.objectKey, "instruction.software-checker");
    assert.equal(found?.status, "approved");

    const firstEdge = await upsertLibraryEdge(db, {
      fromObjectKey: "profile.software-checker-codex",
      fromVersionRef: "profile.software-checker-codex@v1",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.software-checker",
      toVersionRef: "instruction.software-checker@v2",
      scope: "software",
      status: "active",
      weight: 1,
      metadata: { source: "seed-v1" },
    });
    assert.equal(firstEdge.status, "active");
    assert.equal(firstEdge.weight, 1);

    const secondEdge = await upsertLibraryEdge(db, {
      fromObjectKey: "profile.software-checker-codex",
      fromVersionRef: "profile.software-checker-codex@v1",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.software-checker",
      toVersionRef: "instruction.software-checker@v2",
      scope: "software",
      status: "active",
      weight: 2,
      metadata: { source: "seed-v2" },
    });
    assert.equal(secondEdge.id, firstEdge.id);
    assert.equal(secondEdge.weight, 2);
    assert.deepEqual(secondEdge.metadata, { source: "seed-v2" });

    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.software-checker-codex",
      fromVersionRef: "profile.software-checker-codex@v1",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.software-checker-draft",
      toVersionRef: "instruction.software-checker-draft@v1",
      scope: "software",
      status: "inactive",
      weight: 1,
      metadata: { source: "inactive-edge" },
    });

    const outgoing = await findLibraryEdgesFrom(db, "profile.software-checker-codex", "uses_instruction");
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]?.toObjectKey, "instruction.software-checker");
    assert.equal(outgoing[0]?.weight, 2);

    const incoming = await findLibraryEdgesTo(db, "instruction.software-checker", "uses_instruction");
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0]?.fromObjectKey, "profile.software-checker-codex");
  } finally {
    await db.close();
  }
});

test("library graph store isolates duplicate relations by scope when scope filter is provided", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "profile.multi-scope",
      objectKind: "agent_profile",
      status: "approved",
      headVersionId: "profile.multi-scope@v1",
      state: { scope: "global", displayName: "Multi Scope Profile" },
    });
    await upsertLibraryObject(db, {
      objectKey: "instruction.shared-target",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.shared-target@v1",
      state: { scope: "global", title: "Shared Target Instruction" },
    });

    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.multi-scope",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.shared-target",
      scope: "software",
      status: "active",
      metadata: { label: "software-relation" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.multi-scope",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.shared-target",
      scope: "finance",
      status: "active",
      metadata: { label: "finance-relation" },
    });

    const allOutgoing = await findLibraryEdgesFrom(db, "profile.multi-scope", "uses_instruction");
    assert.equal(allOutgoing.length, 2);

    const softwareOnly = await findLibraryEdgesFrom(db, "profile.multi-scope", "uses_instruction", { scope: "software" });
    assert.equal(softwareOnly.length, 1);
    assert.equal(softwareOnly[0]?.scope, "software");

    const financeOnlyIncoming = await findLibraryEdgesTo(db, "instruction.shared-target", "uses_instruction", {
      scope: "finance",
    });
    assert.equal(financeOnlyIncoming.length, 1);
    assert.equal(financeOnlyIncoming[0]?.scope, "finance");
  } finally {
    await db.close();
  }
});

test("library graph store honors explicit status filter and keeps active-only default", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "profile.status-mix",
      objectKind: "agent_profile",
      status: "approved",
      headVersionId: "profile.status-mix@v1",
      state: { scope: "software", displayName: "Status Mix Profile" },
    });
    await upsertLibraryObject(db, {
      objectKey: "instruction.active-target",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.active-target@v1",
      state: { scope: "software", title: "Active Target" },
    });
    await upsertLibraryObject(db, {
      objectKey: "instruction.inactive-target",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.inactive-target@v1",
      state: { scope: "software", title: "Inactive Target" },
    });
    await upsertLibraryObject(db, {
      objectKey: "instruction.blocked-target",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.blocked-target@v1",
      state: { scope: "software", title: "Blocked Target" },
    });

    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.status-mix",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.active-target",
      scope: "software",
      status: "active",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.status-mix",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.inactive-target",
      scope: "software",
      status: "inactive",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.status-mix",
      edgeType: "uses_instruction",
      toObjectKey: "instruction.blocked-target",
      scope: "software",
      status: "blocked",
    });

    const defaultOutgoing = await findLibraryEdgesFrom(db, "profile.status-mix", "uses_instruction");
    assert.deepEqual(defaultOutgoing.map((row) => row.toObjectKey), ["instruction.active-target"]);

    const inactiveOutgoing = await findLibraryEdgesFrom(db, "profile.status-mix", "uses_instruction", { status: "inactive" });
    assert.deepEqual(inactiveOutgoing.map((row) => row.toObjectKey), ["instruction.inactive-target"]);

    const blockedOutgoing = await findLibraryEdgesFrom(db, "profile.status-mix", "uses_instruction", { status: "blocked" });
    assert.deepEqual(blockedOutgoing.map((row) => row.toObjectKey), ["instruction.blocked-target"]);

    const blockedIncoming = await findLibraryEdgesTo(db, "instruction.blocked-target", "uses_instruction", { status: "blocked" });
    assert.equal(blockedIncoming.length, 1);
    assert.equal(blockedIncoming[0]?.fromObjectKey, "profile.status-mix");
    assert.equal(blockedIncoming[0]?.status, "blocked");
  } finally {
    await db.close();
  }
});
