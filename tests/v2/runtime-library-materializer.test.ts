import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLibraryObjectByKey, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { materializeTaskLibraryRefs } from "../../src/v2/orchestration/runtime-library-materializer.ts";
import { captureRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("snapshot capture rejects swapped object-version pairs", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const objectKey of ["instruction.pair-a", "instruction.pair-b"]) {
      await upsertLibraryObject(db, {
        objectKey,
        objectKind: "instruction_template",
        status: "approved",
        headVersionId: `${objectKey}@v1`,
        state: { content: objectKey, variables: [] },
      });
    }
    await createWorkflowRunPg(db, {
      id: "run-swapped-pairs",
      status: "created",
      domain: "test",
      goalPrompt: "reject swapped pairs",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    await assert.rejects(
      () => captureRunLibrarySnapshotPg(db, {
        runId: "run-swapped-pairs",
        goalContractHash: "1".repeat(64),
        manifestHash: "2".repeat(64),
        libraryObjectVersionRefs: [
          { objectKey: "instruction.pair-a", versionRef: "instruction.pair-b@v1" },
          { objectKey: "instruction.pair-b", versionRef: "instruction.pair-a@v1" },
        ],
      }),
      /version mismatch.*instruction\.pair-a/i,
    );
  } finally {
    await db.close();
  }
});

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
        libraryObjectVersionRefs: [{ objectKey: "instruction.article-builder", versionRef: "instruction.article-builder@v2" }],
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

test("snapshot capture rejects symlinked bundle roots and recursive entries", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-safe-root-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "southstar-library-outside-"));
  try {
    await mkdir(join(libraryRoot, "skills", "entry-link"), { recursive: true });
    await writeFile(join(outsideRoot, "outside.md"), "outside bundle content", "utf8");
    await symlink(join(outsideRoot, "outside.md"), join(libraryRoot, "skills", "entry-link", "outside.md"), "file");
    await upsertLibraryObject(db, {
      objectKey: "skill.entry-link",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.entry-link@1",
      state: { body: "safe", assetBundlePath: "library/skills/entry-link" },
    });
    await createSnapshotRun(db, "run-entry-link");
    await assert.rejects(
      () => captureRunLibrarySnapshotPg(db, {
        runId: "run-entry-link",
        manifestHash: "2".repeat(64),
        libraryRoot,
        libraryObjectVersionRefs: [{ objectKey: "skill.entry-link", versionRef: "skill.entry-link@1" }],
      }),
      /symlink|escapes library root/i,
    );

    await symlink(outsideRoot, join(libraryRoot, "skills", "root-link"), "dir");
    await upsertLibraryObject(db, {
      objectKey: "skill.root-link",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.root-link@1",
      state: { body: "safe", assetBundlePath: "library/skills/root-link" },
    });
    await createSnapshotRun(db, "run-root-link");
    await assert.rejects(
      () => captureRunLibrarySnapshotPg(db, {
        runId: "run-root-link",
        manifestHash: "2".repeat(64),
        libraryRoot,
        libraryObjectVersionRefs: [{ objectKey: "skill.root-link", versionRef: "skill.root-link@1" }],
      }),
      /symlink|escapes library root/i,
    );
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("snapshot capture enforces per-file and total skill bundle byte ceilings", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-size-ceiling-"));
  try {
    const perFileRoot = join(libraryRoot, "skills", "large-file");
    await mkdir(perFileRoot, { recursive: true });
    await writeFile(join(perFileRoot, "large.md"), Buffer.alloc(256 * 1024 + 1, 97));
    await upsertLibraryObject(db, {
      objectKey: "skill.large-file",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.large-file@1",
      state: { body: "safe", assetBundlePath: "library/skills/large-file" },
    });
    await createSnapshotRun(db, "run-large-file");
    await assert.rejects(
      () => captureRunLibrarySnapshotPg(db, {
        runId: "run-large-file",
        manifestHash: "2".repeat(64),
        libraryRoot,
        libraryObjectVersionRefs: [{ objectKey: "skill.large-file", versionRef: "skill.large-file@1" }],
      }),
      /bundle file.*too large|per-file.*limit/i,
    );

    const totalRoot = join(libraryRoot, "skills", "large-total");
    await mkdir(totalRoot, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(totalRoot, `${index}.md`), Buffer.alloc(225 * 1024, 98));
    }
    await upsertLibraryObject(db, {
      objectKey: "skill.large-total",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.large-total@1",
      state: { body: "safe", assetBundlePath: "library/skills/large-total" },
    });
    await createSnapshotRun(db, "run-large-total");
    await assert.rejects(
      () => captureRunLibrarySnapshotPg(db, {
        runId: "run-large-total",
        manifestHash: "2".repeat(64),
        libraryRoot,
        libraryObjectVersionRefs: [{ objectKey: "skill.large-total", versionRef: "skill.large-total@1" }],
      }),
      /bundle total.*too large|total.*limit/i,
    );
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("snapshot capture rejects normalized credential keys but preserves vault reference metadata", async () => {
  const db = await createTestPostgresDb();
  try {
    const sensitiveKeys = [
      "AWS_SECRET_ACCESS_KEY",
      "clientSecret",
      "refreshToken",
      "bearerToken",
      "dbPassword",
      "privateKey",
      "accessToken",
    ];
    for (const [index, sensitiveKey] of sensitiveKeys.entries()) {
      const objectKey = `instruction.secret-key-${index}`;
      const versionRef = `${objectKey}@1`;
      await upsertLibraryObject(db, {
        objectKey,
        objectKind: "instruction_template",
        status: "approved",
        headVersionId: versionRef,
        state: { content: "safe", [sensitiveKey]: "plain-sensitive-value" },
      });
      const runId = `run-secret-key-${index}`;
      await createSnapshotRun(db, runId);
      await assert.rejects(
        () => captureRunLibrarySnapshotPg(db, {
          runId,
          manifestHash: "2".repeat(64),
          libraryObjectVersionRefs: [{ objectKey, versionRef }],
        }),
        new RegExp(`credential-looking.*${sensitiveKey}`, "i"),
      );
    }

    await upsertLibraryObject(db, {
      objectKey: "vault.safe-refs",
      objectKind: "vault_lease_policy",
      status: "approved",
      headVersionId: "vault.safe-refs@1",
      state: {
        secretGroupRef: "github.write",
        leaseRef: "vault.github-write-token",
        vaultLeasePolicyRef: "vault.policy.github",
        accessTokenRef: "vault.github-access-token",
        passwordPolicyRef: "policy.password-rotation",
      },
    });
    await createSnapshotRun(db, "run-safe-refs");
    const snapshot = await captureRunLibrarySnapshotPg(db, {
      runId: "run-safe-refs",
      manifestHash: "2".repeat(64),
      libraryObjectVersionRefs: [{ objectKey: "vault.safe-refs", versionRef: "vault.safe-refs@1" }],
    });
    assert.equal(snapshot.objects[0]?.state.secretGroupRef, "github.write");
    assert.equal(snapshot.objects[0]?.state.accessTokenRef, "vault.github-access-token");
  } finally {
    await db.close();
  }
});

test("snapshot hash excludes capture time for identical semantic inputs", async () => {
  const firstDb = await createTestPostgresDb();
  const secondDb = await createTestPostgresDb();
  try {
    await createSnapshotRun(firstDb, "run-stable-hash");
    const first = await captureRunLibrarySnapshotPg(firstDb, {
      runId: "run-stable-hash",
      manifestHash: "2".repeat(64),
      libraryObjectVersionRefs: [],
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await createSnapshotRun(secondDb, "run-stable-hash");
    const second = await captureRunLibrarySnapshotPg(secondDb, {
      runId: "run-stable-hash",
      manifestHash: "2".repeat(64),
      libraryObjectVersionRefs: [],
    });

    assert.notEqual(first.createdAt, second.createdAt);
    assert.equal(first.snapshotHash, second.snapshotHash);
  } finally {
    await firstDb.close();
    await secondDb.close();
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
  const libraryObjectVersionRefs: Array<{ objectKey: string; versionRef: string }> = [];
  for (const objectKey of objectKeys) {
    const object = await findLibraryObjectByKey(db, objectKey);
    assert.ok(object?.headVersionId, `missing fixture Library head: ${objectKey}`);
    libraryObjectVersionRefs.push({ objectKey, versionRef: object.headVersionId });
  }
  await createSnapshotRun(db, runId);
  await captureRunLibrarySnapshotPg(db, {
    runId,
    goalContractHash: "1".repeat(64),
    manifestHash: "2".repeat(64),
    libraryObjectVersionRefs,
    ...(libraryRoot ? { libraryRoot } : {}),
  });
}

async function createSnapshotRun(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
): Promise<void> {
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
}
