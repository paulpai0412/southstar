import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileWatchWriter } from "../../src/runtime/watch-lock.ts";
import { compactWatchLogLine, containsSecretLeak } from "../../src/runtime/watch-logger.ts";
import { createWatchLoop } from "../../src/runtime/watch.ts";

test("watch loop reconstructs work from store on each cycle", async () => {
  const loaded: string[] = [];
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 2,
    acquireWriter: async () => ({ release: async () => undefined }),
    runCycle: async () => {
      loaded.push("cycle");
      return { activeIssues: 1, effectsStarted: 0 };
    },
    sleep: async () => undefined,
    shouldStop: () => false,
  });

  const result = await loop.run();

  assert.equal(result.cycles, 2);
  assert.deepEqual(loaded, ["cycle", "cycle"]);
});

test("watch loop stops before starting new effects after shutdown begins", async () => {
  let cycles = 0;
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 5,
    acquireWriter: async () => ({ release: async () => undefined }),
    runCycle: async () => {
      cycles += 1;
      return { activeIssues: 1, effectsStarted: 1 };
    },
    sleep: async () => undefined,
    shouldStop: () => cycles >= 1,
  });

  const result = await loop.run();

  assert.equal(result.cycles, 1);
});

test("watch loop enforces one writer per project", async () => {
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 1,
    acquireWriter: async () => undefined,
    runCycle: async () => ({ activeIssues: 0, effectsStarted: 0 }),
    sleep: async () => undefined,
    shouldStop: () => false,
  });

  const result = await loop.run();

  assert.equal(result.cycles, 0);
  assert.equal(result.skipped_reason, "writer_lock_unavailable");
});

test("watch loop heartbeats writer lease before and after each completed cycle", async () => {
  const heartbeats: string[] = [];
  let tick = 0;
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 2,
    acquireWriter: async () => ({
      heartbeat: async (now) => {
        heartbeats.push(now ?? "missing");
      },
      release: async () => undefined,
    }),
    runCycle: async () => ({ activeIssues: 1, effectsStarted: 0 }),
    sleep: async () => undefined,
    shouldStop: () => false,
    now: () => `2026-05-31T01:00:0${tick++}.000Z`,
  });

  const result = await loop.run();

  assert.equal(result.cycles, 2);
  assert.deepEqual(heartbeats, [
    "2026-05-31T01:00:00.000Z",
    "2026-05-31T01:00:01.000Z",
    "2026-05-31T01:00:02.000Z",
    "2026-05-31T01:00:03.000Z",
  ]);
});

test("watch loop heartbeats writer lease before starting a long cycle", async () => {
  const heartbeats: string[] = [];
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 1,
    acquireWriter: async () => ({
      heartbeat: async (now) => {
        heartbeats.push(now ?? "missing");
      },
      release: async () => undefined,
    }),
    runCycle: async () => {
      assert.deepEqual(heartbeats, ["2026-05-31T01:30:00.000Z"]);
      return { activeIssues: 1, effectsStarted: 0 };
    },
    sleep: async () => undefined,
    shouldStop: () => false,
    now: () => "2026-05-31T01:30:00.000Z",
  });

  const result = await loop.run();

  assert.equal(result.cycles, 1);
  assert.deepEqual(heartbeats, [
    "2026-05-31T01:30:00.000Z",
    "2026-05-31T01:30:00.000Z",
  ]);
});

test("watch loop stops before a cycle when writer ownership is lost", async () => {
  let ownerChecks = 0;
  let cycles = 0;
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 2,
    acquireWriter: async () => ({
      assertCurrentOwner: async () => {
        ownerChecks += 1;
        if (ownerChecks > 1) {
          throw new Error("stale watch lock owner");
        }
      },
      heartbeat: async () => undefined,
      release: async () => undefined,
    }),
    runCycle: async () => {
      cycles += 1;
      return { activeIssues: 1, effectsStarted: 0 };
    },
    sleep: async () => undefined,
    shouldStop: () => false,
  });

  const result = await loop.run();

  assert.equal(cycles, 1);
  assert.equal(result.cycles, 1);
  assert.equal(result.skipped_reason, "writer_lock_lost");
});

test("watch loop reports ownership loss when heartbeat fails after a completed cycle", async () => {
  let cycles = 0;
  let heartbeats = 0;
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 2,
    acquireWriter: async () => ({
      assertCurrentOwner: async () => undefined,
      heartbeat: async () => {
        heartbeats += 1;
        if (heartbeats > 1) {
          throw new Error("stale watch lock owner");
        }
      },
      release: async () => undefined,
    }),
    runCycle: async () => {
      cycles += 1;
      return { activeIssues: 1, effectsStarted: 0 };
    },
    sleep: async () => undefined,
    shouldStop: () => false,
  });

  const result = await loop.run();

  assert.equal(cycles, 1);
  assert.equal(result.cycles, 1);
  assert.equal(result.skipped_reason, "writer_lock_lost");
});

test("file watch writer lock rejects a second writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-lock-"));
  try {
    const input = {
      path: join(dir, "watch.lock"),
      projectRoot: dir,
      configPath: join(dir, ".northstar.yaml"),
      staleAfterSeconds: 120,
      now: () => "2026-05-31T01:00:00.000Z",
      isPidAlive: () => true,
    };
    const first = await acquireFileWatchWriter(input);
    const second = await acquireFileWatchWriter(input);

    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.reason, "fresh_writer_exists");
    await first.lease?.release();
    const third = await acquireFileWatchWriter(input);
    assert.equal(third.acquired, true);
    await third.lease?.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact watch logs include cycle metrics and reject secret-shaped values", () => {
  const line = compactWatchLogLine({
    event: "watch_cycle",
    cycle: 1,
    active_issues: 2,
    effects_started: 0,
  });

  assert.match(line, /watch_cycle/);
  assert.match(line, /"cycle":1/);
  assert.equal(containsSecretLeak(line), false);
  assert.equal(containsSecretLeak("Authorization: Bearer abcdefghijklmnop"), true);
});
