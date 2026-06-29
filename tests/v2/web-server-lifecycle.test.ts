import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServerLifecycle } from "../../src/v2/server/web-server-lifecycle.ts";

test("start exports the runtime API URL under all web env names", async () => {
  const appCwd = await mkdtemp(join(tmpdir(), "southstar-web-lifecycle-"));
  const readyServer = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    readyServer.once("error", reject);
    readyServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = readyServer.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  let launchedScript = "";
  const lifecycle = createWebServerLifecycle({
    cwd: "/tmp/southstar",
    now: () => new Date("2026-06-29T00:00:00.000Z"),
    runCommand: async (_command, args) => {
      launchedScript = args[1] ?? "";
      return { exitCode: 0, stdout: "4242\n", stderr: "" };
    },
    processKill: (pid) => {
      if (pid === 4242) return;
      const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
      throw error;
    },
    writeTextFile: async () => {},
    ensureDirectory: async () => {},
    readTextFile: async () => {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    },
    removeFile: async () => {},
  });

  try {
    await lifecycle.start({
      host: "127.0.0.1",
      port,
      apiUrl: "http://127.0.0.1:3100",
      appCwd,
    });
  } finally {
    readyServer.close();
    await rm(appCwd, { recursive: true, force: true });
  }

  assert.match(launchedScript, /NEXT_PUBLIC_SOUTHSTAR_SERVER_URL='http:\/\/127\.0\.0\.1:3100'/);
  assert.match(launchedScript, /SOUTHSTAR_SERVER_URL='http:\/\/127\.0\.0\.1:3100'/);
  assert.match(launchedScript, /SOUTHSTAR_V2_API_BASE_URL='http:\/\/127\.0\.0\.1:3100'/);
});
