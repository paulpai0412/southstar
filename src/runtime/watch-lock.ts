import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { link, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export interface WatchLockRecord {
  pid: number;
  started_at: string;
  heartbeat_at: string;
  project_root: string;
  config_path: string;
  host: string;
  lease_id: string;
}

export type WatchLockAcquireReason =
  | "new_lock"
  | "pid_not_running"
  | "heartbeat_stale"
  | "fresh_writer_exists"
  | "project_mismatch"
  | "invalid_lock_reclaimed";

export interface FileWatchWriterLease {
  assertCurrentOwner(): Promise<void>;
  heartbeat(now?: string): Promise<void>;
  release(): Promise<void>;
}

export interface WatchLockAcquireResult {
  acquired: boolean;
  reclaimed: boolean;
  reason: WatchLockAcquireReason;
  previous?: WatchLockRecord;
  lease?: FileWatchWriterLease;
}

export interface WatchLockAcquireInput {
  path: string;
  projectRoot: string;
  configPath: string;
  staleAfterSeconds: number;
  now?: () => string;
  isPidAlive?: (pid: number) => boolean;
  host?: string;
  testHooks?: WatchLockTestHooks;
}

interface WatchLockTestHooks {
  beforeHeartbeatWrite?: () => Promise<void>;
  beforeReleaseRemove?: () => Promise<void>;
  beforeReclaimPublish?: () => Promise<void>;
  beforeReclaimLink?: () => Promise<void>;
}

export async function acquireFileWatchWriter(input: WatchLockAcquireInput): Promise<WatchLockAcquireResult> {
  const createRecord = (now: string): WatchLockRecord => ({
    pid: globalThis.process?.pid ?? 0,
    started_at: now,
    heartbeat_at: now,
    project_root: input.projectRoot,
    config_path: input.configPath,
    host: input.host ?? hostname(),
    lease_id: randomUUID(),
  });

  const now = input.now ?? (() => new Date().toISOString());
  const record = createRecord(now());
  const created = await tryCreateLock(input.path, record);
  if (created) {
    return {
      acquired: true,
      reclaimed: false,
      reason: "new_lock",
      lease: leaseFor(input.path, record, input.testHooks),
    };
  }

  const previous = await readLock(input.path);
  if (!previous) {
    const reclaimedRecord = createRecord(now());
    const replaced = await tryReplaceLock(input.path, reclaimedRecord, undefined, input.testHooks);
    if (!replaced) {
      return {
        acquired: false,
        reclaimed: false,
        reason: "fresh_writer_exists",
      };
    }
    return {
      acquired: true,
      reclaimed: true,
      reason: "invalid_lock_reclaimed",
      lease: leaseFor(input.path, reclaimedRecord, input.testHooks),
    };
  }

  if (previous.project_root !== input.projectRoot || previous.config_path !== input.configPath) {
    return {
      acquired: false,
      reclaimed: false,
      reason: "project_mismatch",
      previous,
    };
  }

  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
  const heartbeatAgeMs = Date.parse(now()) - Date.parse(previous.heartbeat_at);
  const staleAfterMs = input.staleAfterSeconds * 1000;
  const reclaimReason: WatchLockAcquireReason | undefined = !isPidAlive(previous.pid)
    ? "pid_not_running"
    : heartbeatAgeMs > staleAfterMs
      ? "heartbeat_stale"
      : undefined;

  if (!reclaimReason) {
    return {
      acquired: false,
      reclaimed: false,
      reason: "fresh_writer_exists",
      previous,
    };
  }

  const reclaimedRecord = createRecord(now());
  const replaced = await tryReplaceLock(input.path, reclaimedRecord, previous, input.testHooks);
  if (!replaced) {
    return {
      acquired: false,
      reclaimed: false,
      reason: "fresh_writer_exists",
      previous,
    };
  }
  return {
    acquired: true,
    reclaimed: true,
    reason: reclaimReason,
    previous,
    lease: leaseFor(input.path, reclaimedRecord, input.testHooks),
  };
}

async function tryCreateLock(path: string, record: WatchLockRecord): Promise<boolean> {
  const ownerPath = ownerPathFor(path, record.lease_id);
  try {
    const handle = await open(ownerPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }
    try {
      await link(ownerPath, path);
    } catch (error) {
      await rm(ownerPath, { force: true });
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST") {
        return false;
      }
      throw new Error(`Unable to publish watch lock ownership: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cleanupOwnerFiles(path, record.lease_id);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST") {
      await rm(ownerPath, { force: true });
      return false;
    }
    throw error;
  }
}

async function readLock(path: string): Promise<WatchLockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<WatchLockRecord>;
    if (
      typeof value.pid === "number"
      && typeof value.started_at === "string"
      && typeof value.heartbeat_at === "string"
      && typeof value.project_root === "string"
      && typeof value.config_path === "string"
      && typeof value.host === "string"
      && (value.lease_id === undefined || typeof value.lease_id === "string")
    ) {
      return {
        ...value,
        lease_id: value.lease_id ?? "",
      } as WatchLockRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function leaseFor(path: string, record: WatchLockRecord, testHooks?: WatchLockTestHooks): FileWatchWriterLease {
  let current = record;
  let released = false;
  const ownerPath = ownerPathFor(path, record.lease_id);
  return {
    async assertCurrentOwner() {
      await assertCurrentOwner(path, current.lease_id);
    },
    async heartbeat(now = new Date().toISOString()) {
      if (released) return;
      await assertCurrentOwner(path, current.lease_id);
      await testHooks?.beforeHeartbeatWrite?.();
      current = { ...current, heartbeat_at: now };
      await writeOwnerLock(ownerPath, current);
      await assertCurrentOwner(path, current.lease_id);
    },
    async release() {
      released = true;
      if (!await isCurrentOwner(path, current.lease_id)) {
        await rm(ownerPath, { force: true });
        return;
      }
      await testHooks?.beforeReleaseRemove?.();
      if (!await isCurrentOwner(path, current.lease_id)) {
        await rm(ownerPath, { force: true });
        return;
      }
      await rm(path, { force: true });
      await rm(ownerPath, { force: true });
      await cleanupOwnerFiles(path);
    },
  };
}

async function tryReplaceLock(
  path: string,
  record: WatchLockRecord,
  expectedPrevious: WatchLockRecord | undefined,
  testHooks?: WatchLockTestHooks,
): Promise<boolean> {
  const ownerPath = ownerPathFor(path, record.lease_id);
  await writeOwnerLock(ownerPath, record);
  await testHooks?.beforeReclaimPublish?.();
  if (!await currentMatchesExpected(path, expectedPrevious)) {
    await rm(ownerPath, { force: true });
    return false;
  }
  await rm(path, { force: true });
  await testHooks?.beforeReclaimLink?.();
  try {
    await link(ownerPath, path);
  } catch (error) {
    await rm(ownerPath, { force: true });
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST") {
      return false;
    }
    if (await readLock(path)) {
      return false;
    }
    throw new Error(`Unable to publish watch lock ownership: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!await isCurrentOwner(path, record.lease_id)) {
    await rm(ownerPath, { force: true });
    return false;
  }
  await cleanupOwnerFiles(path, record.lease_id);
  return true;
}

async function writeOwnerLock(ownerPath: string, record: WatchLockRecord): Promise<void> {
  await writeFile(ownerPath, JSON.stringify(record));
}

async function assertCurrentOwner(path: string, leaseId: string): Promise<void> {
  if (!await isCurrentOwner(path, leaseId)) {
    throw new Error("stale watch lock owner");
  }
}

async function isCurrentOwner(path: string, leaseId: string): Promise<boolean> {
  if (!leaseId) return false;
  try {
    const [lockStats, ownerStats] = await Promise.all([
      stat(path),
      stat(ownerPathFor(path, leaseId)),
    ]);
    return lockStats.dev === ownerStats.dev && lockStats.ino === ownerStats.ino;
  } catch {
    return false;
  }
}

async function currentMatchesExpected(path: string, expected: WatchLockRecord | undefined): Promise<boolean> {
  const current = await readLock(path);
  if (!current) return expected === undefined;
  if (!expected) return false;
  if (expected.lease_id || current.lease_id) {
    return current.lease_id === expected.lease_id;
  }
  return current.pid === expected.pid
    && current.started_at === expected.started_at
    && current.heartbeat_at === expected.heartbeat_at
    && current.project_root === expected.project_root
    && current.config_path === expected.config_path
    && current.host === expected.host;
}

async function cleanupOwnerFiles(path: string, keepLeaseId?: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const keep = keepLeaseId ? `${prefix}${keepLeaseId}.owner` : undefined;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(files
    .filter((file) => file.startsWith(prefix) && file.endsWith(".owner") && file !== keep)
    .map((file) => rm(`${dir}/${file}`, { force: true })));
}

function ownerPathFor(path: string, leaseId: string): string {
  return `${path}.${leaseId}.owner`;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!pid || !globalThis.process?.kill) return false;
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
