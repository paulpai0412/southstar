import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { acquireFileWatchWriter } from "../../src/runtime/watch-lock.ts";

async function tmpRoot(name: string) {
  const root = join(tmpdir(), `northstar-lock-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

test("structured watch lock writes heartbeat and releases lock", async () => {
  const root = await tmpRoot("structured");
  const lockPath = join(root, "watch.lock");
  try {
    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath: join(root, ".northstar.yaml"),
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
      host: "test-host",
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, "new_lock");

    await result.lease!.heartbeat("2026-05-31T01:00:30.000Z");
    const record = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(record.project_root, root);
    assert.equal(record.config_path, join(root, ".northstar.yaml"));
    assert.equal(record.host, "test-host");
    assert.equal(record.started_at, "2026-05-31T01:00:00.000Z");
    assert.equal(record.heartbeat_at, "2026-05-31T01:00:30.000Z");

    await result.lease!.release();
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale lock with dead pid is reclaimed and reports recovery metadata", async () => {
  const root = await tmpRoot("dead-pid");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 99999,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:00:00.000Z",
      project_root: root,
      config_path: configPath,
      host: "test-host",
    }));

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => false,
      host: "new-host",
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reclaimed, true);
    assert.equal(result.reason, "pid_not_running");
    assert.equal(result.previous?.pid, 99999);
    assert.equal(result.previous?.heartbeat_at, "2026-05-31T00:00:00.000Z");
    await result.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale lock with live pid is reclaimed when heartbeat is stale", async () => {
  const root = await tmpRoot("stale-heartbeat");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 111,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:57:59.000Z",
      project_root: root,
      config_path: configPath,
      host: "test-host",
    }));

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reclaimed, true);
    assert.equal(result.reason, "heartbeat_stale");
    await result.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh lock is rejected without creating duplicate writer", async () => {
  const root = await tmpRoot("fresh");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 111,
      started_at: "2026-05-31T01:00:00.000Z",
      heartbeat_at: "2026-05-31T01:00:30.000Z",
      project_root: root,
      config_path: configPath,
      host: "test-host",
    }));

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:01:00.000Z",
      isPidAlive: () => true,
    });

    assert.equal(result.acquired, false);
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, "fresh_writer_exists");
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 111);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project root mismatch rejects stale-looking lock", async () => {
  const root = await tmpRoot("mismatch");
  const lockPath = join(root, "watch.lock");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 111,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:00:00.000Z",
      project_root: "/other/repo",
      config_path: "/other/repo/.northstar.yaml",
      host: "test-host",
    }));

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath: join(root, ".northstar.yaml"),
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => false,
    });

    assert.equal(result.acquired, false);
    assert.equal(result.reason, "project_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config path mismatch rejects stale-looking lock", async () => {
  const root = await tmpRoot("config-mismatch");
  const lockPath = join(root, "watch.lock");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 111,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:00:00.000Z",
      project_root: root,
      config_path: join(root, "other.yaml"),
      host: "test-host",
    }));

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath: join(root, ".northstar.yaml"),
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => false,
    });

    assert.equal(result.acquired, false);
    assert.equal(result.reason, "project_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid lock is reclaimed with invalid lock reason", async () => {
  const root = await tmpRoot("invalid");
  const lockPath = join(root, "watch.lock");
  try {
    await writeFile(lockPath, "{not-json");

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath: join(root, ".northstar.yaml"),
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reclaimed, true);
    assert.equal(result.reason, "invalid_lock_reclaimed");
    await result.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("superseded lease cannot heartbeat or release reclaimed lock", async () => {
  const root = await tmpRoot("superseded-owner");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    const first = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
      host: "first-host",
    });
    assert.equal(first.acquired, true);

    const second = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:03:00.000Z",
      isPidAlive: () => false,
      host: "second-host",
    });
    assert.equal(second.acquired, true);
    assert.equal(second.reclaimed, true);

    const secondRecord = JSON.parse(await readFile(lockPath, "utf8"));
    await assert.rejects(
      () => first.lease!.heartbeat("2026-05-31T01:04:00.000Z"),
      /stale watch lock owner/,
    );
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), secondRecord);

    await first.lease!.release();
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), secondRecord);

    await second.lease!.heartbeat("2026-05-31T01:05:00.000Z");
    const heartbeatRecord = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(heartbeatRecord.host, "second-host");
    assert.equal(heartbeatRecord.heartbeat_at, "2026-05-31T01:05:00.000Z");

    await second.lease!.release();
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interleaved reclaim cannot be overwritten or removed by stale owner", async () => {
  const root = await tmpRoot("interleaved-owner");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  let second: Awaited<ReturnType<typeof acquireFileWatchWriter>> | undefined;
  try {
    const first = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
      host: "first-host",
      testHooks: {
        beforeHeartbeatWrite: async () => {
          second = await acquireFileWatchWriter({
            path: lockPath,
            projectRoot: root,
            configPath,
            staleAfterSeconds: 120,
            now: () => "2026-05-31T01:03:00.000Z",
            isPidAlive: () => false,
            host: "second-host",
          });
        },
      },
    });
    assert.equal(first.acquired, true);

    await assert.rejects(
      () => first.lease!.heartbeat("2026-05-31T01:04:00.000Z"),
      /stale watch lock owner/,
    );
    assert.equal(second?.acquired, true);
    const secondRecord = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(secondRecord.host, "second-host");
    assert.equal(secondRecord.heartbeat_at, "2026-05-31T01:03:00.000Z");

    const staleRelease = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:06:00.000Z",
      isPidAlive: () => false,
      host: "stale-release-host",
      testHooks: {
        beforeReleaseRemove: async () => {
          second = await acquireFileWatchWriter({
            path: lockPath,
            projectRoot: root,
            configPath,
            staleAfterSeconds: 120,
            now: () => "2026-05-31T01:09:00.000Z",
            isPidAlive: () => false,
            host: "final-host",
          });
        },
      },
    });
    assert.equal(staleRelease.acquired, true);
    assert.equal(staleRelease.reclaimed, true);

    await staleRelease.lease!.release();
    const finalRecord = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(second?.acquired, true);
    assert.equal(finalRecord.host, "final-host");
    assert.equal(finalRecord.heartbeat_at, "2026-05-31T01:09:00.000Z");

    await second!.lease!.heartbeat("2026-05-31T01:10:00.000Z");
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).heartbeat_at, "2026-05-31T01:10:00.000Z");
    await second!.lease!.release();
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated reclaim cleans stale owner side files", async () => {
  const root = await tmpRoot("owner-cleanup");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    let lease = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
      host: "owner-0",
    });
    assert.equal(lease.acquired, true);

    for (let index = 1; index <= 3; index += 1) {
      lease = await acquireFileWatchWriter({
        path: lockPath,
        projectRoot: root,
        configPath,
        staleAfterSeconds: 120,
        now: () => `2026-05-31T01:0${index + 2}:00.000Z`,
        isPidAlive: () => false,
        host: `owner-${index}`,
      });
      assert.equal(lease.acquired, true);
      assert.equal(lease.reclaimed, true);
    }

    assert.deepEqual((await ownerFiles(root)).sort(), [`${basename(lockPath)}.${JSON.parse(await readFile(lockPath, "utf8")).lease_id}.owner`]);
    await lease.lease!.release();
    assert.deepEqual(await ownerFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interleaved reclaim cannot produce two usable owners", async () => {
  const root = await tmpRoot("interleaved-reclaim");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  let second: Awaited<ReturnType<typeof acquireFileWatchWriter>> | undefined;
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 111,
      started_at: "2026-05-31T01:00:00.000Z",
      heartbeat_at: "2026-05-31T01:00:00.000Z",
      project_root: root,
      config_path: configPath,
      host: "stale-host",
    }));

    const first = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:03:00.000Z",
      isPidAlive: () => false,
      host: "first-reclaimer",
      testHooks: {
        beforeReclaimPublish: async () => {
          second = await acquireFileWatchWriter({
            path: lockPath,
            projectRoot: root,
            configPath,
            staleAfterSeconds: 120,
            now: () => "2026-05-31T01:04:00.000Z",
            isPidAlive: () => false,
            host: "second-reclaimer",
          });
        },
      },
    });

    assert.equal(second?.acquired, true);
    assert.equal(first.acquired, false);
    assert.equal(first.reason, "fresh_writer_exists");
    assert.equal(first.lease, undefined);
    await second!.lease!.assertCurrentOwner!();
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).host, "second-reclaimer");
    await second!.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaim publish link contention returns not acquired instead of throwing", async () => {
  const root = await tmpRoot("link-contention");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  let second: Awaited<ReturnType<typeof acquireFileWatchWriter>> | undefined;
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 111,
      started_at: "2026-05-31T01:00:00.000Z",
      heartbeat_at: "2026-05-31T01:00:00.000Z",
      project_root: root,
      config_path: configPath,
      host: "stale-host",
    }));

    const first = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:03:00.000Z",
      isPidAlive: () => false,
      host: "first-reclaimer",
      testHooks: {
        beforeReclaimLink: async () => {
          second = await acquireFileWatchWriter({
            path: lockPath,
            projectRoot: root,
            configPath,
            staleAfterSeconds: 120,
            now: () => "2026-05-31T01:04:00.000Z",
            isPidAlive: () => false,
            host: "second-reclaimer",
          });
        },
      },
    });

    assert.equal(second?.acquired, true);
    assert.equal(first.acquired, false);
    assert.equal(first.reason, "fresh_writer_exists");
    assert.equal(first.lease, undefined);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).host, "second-reclaimer");
    await second!.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("default pid liveness reclaims stale heartbeat when pid is alive", async () => {
  const root = await tmpRoot("default-pid-alive");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:00:00.000Z",
      project_root: root,
      config_path: configPath,
      host: "existing-host",
    }));

    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reclaimed, true);
    assert.equal(result.reason, "heartbeat_stale");
    await result.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default pid liveness treats zero or missing process ids as not running", async () => {
  const root = await tmpRoot("default-pid-missing");
  const lockPath = join(root, "watch.lock");
  const configPath = join(root, ".northstar.yaml");
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 0,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:00:00.000Z",
      project_root: root,
      config_path: configPath,
      host: "existing-host",
    }));

    const zeroPid = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
    });
    assert.equal(zeroPid.reason, "pid_not_running");
    await zeroPid.lease!.release();

    await writeFile(lockPath, JSON.stringify({
      pid: 999_999_999,
      started_at: "2026-05-31T00:00:00.000Z",
      heartbeat_at: "2026-05-31T00:00:00.000Z",
      project_root: root,
      config_path: configPath,
      host: "existing-host",
    }));

    const unknownPid = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath,
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
    });
    assert.equal(unknownPid.reason, "pid_not_running");
    await unknownPid.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release tolerates directory removal during owner cleanup", async () => {
  const root = await tmpRoot("cleanup-missing-dir");
  const lockPath = join(root, "watch.lock");
  try {
    const result = await acquireFileWatchWriter({
      path: lockPath,
      projectRoot: root,
      configPath: join(root, ".northstar.yaml"),
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
      testHooks: {
        beforeReleaseRemove: async () => {
          await rm(root, { recursive: true, force: true });
        },
      },
    });

    assert.equal(result.acquired, true);
    await result.lease!.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function ownerFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((file) => file.endsWith(".owner"));
}
