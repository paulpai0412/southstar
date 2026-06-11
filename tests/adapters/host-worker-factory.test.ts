import assert from "node:assert/strict";
import { test } from "node:test";

import { HostWorkerFactory } from "../../src/adapters/host/worker-factory.ts";
import type { ProductionHostName } from "../../src/adapters/host/capabilities.ts";
import type { SoftwareDevWorker } from "../../src/orchestrator/software-dev-driver.ts";

test("role host resolver uses global default and role override for all production hosts", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "pi",
    roleOverrides: {
      issue_worker: { host_adapter: "codex" },
      pr_verifier: { host_adapter: "opencode" },
    },
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
    piWorker: () => fakeWorker("pi"),
  });

  assert.equal(resolver.resolveHostForRole("release_worker"), "pi");
  assert.equal(resolver.resolveHostForRole("issue_worker"), "codex");
  assert.equal(resolver.resolveHostForRole("pr_verifier"), "opencode");
  assert.equal(resolver.workerForRole("issue_worker").kind, "codex");
  assert.equal(resolver.workerForRole("pr_verifier").kind, "opencode");
  assert.equal(resolver.workerForRole("release_worker").kind, "pi");
});

test("role host resolver rejects unknown host", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "codex",
    roleOverrides: {
      issue_worker: { host_adapter: "bad" },
    },
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
    piWorker: () => fakeWorker("pi"),
  });

  assert.throws(() => resolver.workerForRole("issue_worker"), /HOST_ADAPTER_UNKNOWN/);
});

test("role host resolver rejects pi host when pi worker is not configured", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "pi",
    roleOverrides: {},
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
  });

  assert.throws(
    () => resolver.workerForRole("release_worker"),
    /HOST_ADAPTER_NOT_CONFIGURED: pi worker is not configured/,
  );
});

function fakeWorker(kind: ProductionHostName): SoftwareDevWorker & { kind: ProductionHostName } {
  return {
    kind,
    async runImplementation() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
    async runVerification() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
  };
}
