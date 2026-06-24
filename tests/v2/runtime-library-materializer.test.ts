import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { materializeTaskLibraryRefs } from "../../src/v2/orchestration/runtime-library-materializer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime library materializer resolves instruction, skill, tool, MCP, and vault refs without secret values", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);

    const materialized = await materializeTaskLibraryRefs(db, {
      runId: "run-materializer-1",
      taskId: "implement-feature",
      sessionId: "session-materializer-1",
      instructionRefs: ["instruction.software-maker"],
      skillRefs: ["skill.software-implementation"],
      toolGrantRefs: ["tool.shell-command", "tool.workspace-read", "tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: ["vault.github-write-token"],
    });

    assert.match(materialized.instructions[0]?.content ?? "", /implement/i);
    assert.equal(materialized.skills[0]?.skillId, "skill.software-implementation");
    assert.deepEqual(materialized.toolProxyPolicy.allowedTools, ["shell", "workspace-read", "workspace-write"]);
    assert.equal(materialized.mcpGrants[0]?.serverId, "filesystem-workspace");
    assert.deepEqual(materialized.mcpGrants[0]?.allowedTools, ["read_file", "write_file", "list_files"]);
    assert.equal(materialized.vaultLeases[0]?.leaseRef, "vault.github-write-token");
    assert.doesNotMatch(JSON.stringify(materialized), /plaintextSecret/i);
  } finally {
    await db.close();
  }
});

test("runtime library materializer fails closed when referenced library objects are missing", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await assert.rejects(
      () =>
        materializeTaskLibraryRefs(db, {
          runId: "run-materializer-2",
          taskId: "implement-feature",
          sessionId: "session-materializer-2",
          instructionRefs: ["instruction.missing"],
          skillRefs: ["skill.software-implementation"],
          toolGrantRefs: ["tool.workspace-read"],
          mcpGrantRefs: [],
          vaultLeasePolicyRefs: [],
        }),
      /missing approved library object/i,
    );
  } finally {
    await db.close();
  }
});
