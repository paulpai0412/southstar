import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { TorkClient } from "../../src/v2/executor/tork-client.ts";

test("submits a Tork job projection through real HTTP", async () => {
  let receivedBody = "";
  let receivedPath = "";
  const server = createServer((request, response) => {
    receivedPath = request.url ?? "";
    request.on("data", (chunk) => {
      receivedBody += String(chunk);
    });
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "tork-job-1", status: "queued" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const client = new TorkClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.submit({
      executor: "tork",
      fingerprint: "fingerprint",
      job: { name: "wf", tasks: [] },
    });

    assert.deepEqual(result, { jobId: "tork-job-1", status: "queued" });
    assert.equal(receivedPath, "/jobs");
    assert.deepEqual(JSON.parse(receivedBody), { name: "wf", tasks: [] });
  } finally {
    server.close();
  }
});

test("materializes Southstar task projection into upstream Tork wire format", async () => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => {
      receivedBody += String(chunk);
    });
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "tork-job-1", state: "PENDING" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const client = new TorkClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.submit({
      executor: "tork",
      fingerprint: "fingerprint",
      job: {
        name: "wf",
        tasks: [{
          id: "task-1",
          name: "Task",
          image: "node:22",
          command: ["southstar-agent-runner", "--envelope", "/southstar/tasks/task-1/envelope.json"],
          env: { SAFE_ENV: "1" },
          mounts: [{ source: "/tmp/work", target: "/workspace", readonly: true }],
          timeoutSeconds: 900,
          retry: { maxAttempts: 2 },
          dependsOn: [],
          webhook: "http://127.0.0.1/callback",
        }],
      },
    });

    assert.deepEqual(result, { jobId: "tork-job-1", status: "PENDING" });
    assert.deepEqual(JSON.parse(receivedBody), {
      name: "wf",
      tasks: [{
        name: "Task",
        image: "node:22",
        cmd: ["southstar-agent-runner", "--envelope", "/southstar/tasks/task-1/envelope.json"],
        env: { SAFE_ENV: "1" },
        mounts: [{ type: "bind", source: "/tmp/work", target: "/workspace", opts: { readonly: "true" } }],
        timeout: "900s",
        retry: { limit: 2 },
      }],
    });
  } finally {
    server.close();
  }
});

test("Tork client fails on non-2xx responses", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("boom");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const client = new TorkClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(() => client.submit({
      executor: "tork",
      fingerprint: "fingerprint",
      job: { name: "wf", tasks: [] },
    }), /Tork submit failed: 500 boom/);
  } finally {
    server.close();
  }
});

test("Tork client aborts requests when timeout is exceeded", async () => {
  const server = createServer((_request, _response) => {
    // Intentionally hold the connection open to trigger timeout.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const client = new TorkClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      requestTimeoutMs: 30,
      retryCount: 0,
    });
    await assert.rejects(() => client.getJob("job-timeout"), /timeout/i);
  } finally {
    server.close();
  }
});
