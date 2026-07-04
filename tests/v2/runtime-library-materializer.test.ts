import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
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
    assert.equal(materialized.mcpRuntimeConfig.schemaVersion, "southstar.mcp_runtime_config.v1");
    assert.equal(materialized.mcpRuntimeConfig.servers[0]?.serverId, "filesystem-workspace");
    assert.equal(materialized.mcpRuntimeConfig.servers[0]?.transport, "stdio");
    assert.deepEqual(materialized.mcpRuntimeConfig.servers[0]?.command, {
      argv: ["node", "/app/src/v2/mcp/filesystem-workspace-server.ts"],
      cwd: "/workspace/repo",
    });
    assert.deepEqual(materialized.mcpRuntimeConfig.servers[0]?.envFromVault, []);
    assert.equal(materialized.vaultLeases[0]?.leaseRef, "vault.github-write-token");
    assert.doesNotMatch(JSON.stringify(materialized), /plaintextSecret/i);
    assert.doesNotMatch(JSON.stringify(materialized.mcpRuntimeConfig), /ghp_|postgres:\/\/|GITHUB_TOKEN=.*secret/i);
  } finally {
    await db.close();
  }
});

test("runtime library materializer keeps MCP credentials as vault references", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "mcp.github",
      objectKind: "mcp_tool_grant",
      status: "approved",
      headVersionId: "mcp.github@1",
      state: {
        serverId: "github",
        allowedTools: ["get_issue", "create_pull_request"],
        transport: "stdio",
        command: "node",
        args: ["/app/src/v2/mcp/github-server.ts"],
        envFromVault: [{ name: "GITHUB_TOKEN", leaseRef: "vault.github-write-token" }],
      },
    });
    await upsertLibraryObject(db, {
      objectKey: "vault.github-write-token",
      objectKind: "vault_lease_policy",
      status: "approved",
      headVersionId: "vault.github-write-token@1",
      state: {
        displayName: "GitHub Write Token",
        secretGroupRef: "github.write",
        leaseTtlSeconds: 900,
        mountMode: "proxy-only",
      },
    });

    const materialized = await materializeTaskLibraryRefs(db, {
      runId: "run-materializer-github",
      taskId: "task-github",
      sessionId: "session-materializer-github",
      instructionRefs: [],
      skillRefs: [],
      toolGrantRefs: [],
      mcpGrantRefs: ["mcp.github"],
      vaultLeasePolicyRefs: ["vault.github-write-token"],
    });

    assert.deepEqual(materialized.mcpRuntimeConfig.servers[0]?.envFromVault, [{
      name: "GITHUB_TOKEN",
      leaseRef: "vault.github-write-token",
    }]);
    assert.equal(materialized.mcpRuntimeConfig.policy.secretsMaterializedByVault, true);
    assert.equal(materialized.vaultLeases[0]?.leaseRef, "vault.github-write-token");
    assert.doesNotMatch(JSON.stringify(materialized), /"secretValue"\s*:|ghp_|github_pat_/i);
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

test("runtime materializer resolves approved skill_spec body and supporting bundle files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-root-"));
  try {
    await mkdir(join(libraryRoot, "skills", "react-ui", "references"), { recursive: true });
    await writeFile(join(libraryRoot, "skills", "react-ui", "references", "patterns.md"), "Use controlled inputs.", "utf8");
    await upsertLibraryObject(db, {
      objectKey: "skill.react-ui",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.react-ui@1",
      state: {
        scope: "software",
        title: "React UI",
        body: "# Instructions\n\nBuild React UI.",
        sourcePath: "library/skills/react-ui.skill.md",
        assetBundlePath: "library/skills/react-ui",
        allowedTools: ["workspace-write"],
        requiredMounts: ["workspace"],
        mcpRequirements: ["filesystem-workspace"],
        artifactContracts: ["artifact.web_app"],
      },
    });

    const materialized = await materializeTaskLibraryRefs(db, {
      runId: "run-skill-spec",
      taskId: "task-ui",
      sessionId: "session-skill-spec",
      libraryRoot,
      instructionRefs: [],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
    });

    assert.equal(materialized.skills[0]?.skillId, "skill.react-ui");
    assert.match(materialized.skills[0]?.instructions ?? "", /Build React UI/);
    assert.deepEqual(materialized.skills[0]?.allowedTools, ["workspace-write"]);
    assert.equal(materialized.skills[0]?.bundleFiles?.[0]?.relativePath, "references/patterns.md");
    assert.equal(
      Buffer.from(materialized.skills[0]?.bundleFiles?.[0]?.contentBase64 ?? "", "base64").toString("utf8"),
      "Use controlled inputs.",
    );
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
