import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLibraryObjectByKey, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { materializeTaskLibraryRefs } from "../../src/v2/orchestration/runtime-library-materializer.ts";
import { captureRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("task materialization uses the run snapshot after Library head changes", async () => {
  const db = await createTestPostgresDb();
  try {
    const state = { content: "BUILD OFFLINE ARTICLE V1", variables: [] };
    await upsertLibraryObject(db, {
      objectKey: "instruction.article-builder",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.article-builder@v1",
      state,
    });
    await captureSnapshotFromHeads(db, "run-article-builder", ["instruction.article-builder"]);
    await upsertLibraryObject(db, {
      objectKey: "instruction.article-builder",
      objectKind: "instruction_template",
      status: "approved",
      headVersionId: "instruction.article-builder@v2",
      state: { content: "MUTATED AFTER RUN CREATION", variables: [] },
    });
    await assert.rejects(
      () => captureRunLibrarySnapshotPg(db, {
        runId: "run-article-builder",
        goalContractHash: "1".repeat(64),
        manifestHash: "2".repeat(64),
        selectedRefs: ["instruction.article-builder"],
        libraryVersionRefs: ["instruction.article-builder@v2"],
      }),
      /snapshot already exists/i,
    );

    const refs = await materializeTaskLibraryRefs(db, {
      runId: "run-article-builder",
      taskId: "task-build-article",
      sessionId: "session-build-article",
      instructionRefs: ["instruction.article-builder"],
      skillRefs: [],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
    });

    assert.equal(refs.instructions[0]!.content, "BUILD OFFLINE ARTICLE V1");
    assert.equal(refs.instructions[0]!.content.includes("MUTATED"), false);
  } finally {
    await db.close();
  }
});

test("skill materialization uses snapshot-backed bundle files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-snapshot-root-"));
  try {
    const bundlePath = join(libraryRoot, "skills", "article-builder", "references", "guide.md");
    await mkdir(join(libraryRoot, "skills", "article-builder", "references"), { recursive: true });
    await writeFile(bundlePath, "SNAPSHOT BUNDLE V1", "utf8");
    const state = {
      body: "# Article Builder V1",
      assetBundlePath: "library/skills/article-builder",
      allowedTools: ["workspace-write"],
    };
    await upsertLibraryObject(db, {
      objectKey: "skill.article-builder",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.article-builder@v1",
      state,
    });
    await captureSnapshotFromHeads(db, "run-skill-article-builder", ["skill.article-builder"], libraryRoot);
    await upsertLibraryObject(db, {
      objectKey: "skill.article-builder",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.article-builder@v2",
      state: { ...state, body: "# MUTATED ARTICLE BUILDER V2" },
    });
    await writeFile(bundlePath, "MUTATED BUNDLE V2", "utf8");

    const refs = await materializeTaskLibraryRefs(db, {
      runId: "run-skill-article-builder",
      taskId: "task-build-article",
      sessionId: "session-build-article",
      libraryRoot,
      instructionRefs: [],
      skillRefs: ["skill.article-builder"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
    });

    assert.equal(refs.skills[0]!.version, "skill.article-builder@v1");
    assert.match(refs.skills[0]!.instructions, /Article Builder V1/);
    assert.equal(
      Buffer.from(refs.skills[0]!.bundleFiles![0]!.contentBase64, "base64").toString("utf8"),
      "SNAPSHOT BUNDLE V1",
    );
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("runtime library materializer resolves instruction, skill, tool, MCP, and vault refs without secret values", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await captureSnapshotFromHeads(db, "run-materializer-1", [
      "instruction.software-maker",
      "skill.software-implementation",
      "tool.shell-command",
      "tool.workspace-read",
      "tool.workspace-write",
      "mcp.filesystem-workspace",
      "vault.github-write-token",
    ]);

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
    await captureSnapshotFromHeads(db, "run-materializer-github", [
      "mcp.github",
      "vault.github-write-token",
    ]);

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
    await captureSnapshotFromHeads(db, "run-materializer-2", [
      "skill.software-implementation",
      "tool.workspace-read",
    ]);
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
      /missing .*library object/i,
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
    await captureSnapshotFromHeads(db, "run-skill-spec", ["skill.react-ui"], libraryRoot);

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

async function captureSnapshotFromHeads(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
  objectKeys: string[],
  libraryRoot?: string,
): Promise<void> {
  const libraryVersionRefs: string[] = [];
  for (const objectKey of objectKeys) {
    const object = await findLibraryObjectByKey(db, objectKey);
    assert.ok(object?.headVersionId, `missing fixture Library head: ${objectKey}`);
    libraryVersionRefs.push(object.headVersionId);
  }
  await createWorkflowRunPg(db, {
    id: runId,
    status: "created",
    domain: "test",
    goalPrompt: "test snapshot materialization",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await captureRunLibrarySnapshotPg(db, {
    runId,
    goalContractHash: "1".repeat(64),
    manifestHash: "2".repeat(64),
    selectedRefs: objectKeys,
    libraryVersionRefs,
    ...(libraryRoot ? { libraryRoot } : {}),
  });
}
