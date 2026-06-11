import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultDomainDriverRegistry, DomainDriverRegistryError } from "../../src/orchestrator/domain-registry.ts";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";
import type { WorkflowDefinition } from "../../src/types/workflow.ts";

test("domain registry resolves software development by explicit domain", () => {
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new FakeDomainDriver(),
  });

  const driver = registry.resolve({
    workflow: workflow({ id: "custom_software_flow", domain: "software_development" }),
    config: {},
    dependencies: {},
  });

  assert.ok(driver instanceof FakeDomainDriver);
  assert.equal(registry.metrics().domain_registry_registered_domains, 3);
  assert.equal(registry.metrics().domain_registry_software_dev_resolved, 1);
});

test("domain registry preserves issue_to_pr_release compatibility fallback", () => {
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new FakeDomainDriver(),
  });

  const driver = registry.resolve({
    workflow: workflow({ id: "issue_to_pr_release" }),
    config: {},
    dependencies: {},
  });

  assert.ok(driver instanceof FakeDomainDriver);
});

test("domain registry recognizes deferred domains without software-dev fallback", () => {
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new FakeDomainDriver(),
  });

  assert.throws(
    () => registry.resolve({ workflow: workflow({ id: "content_creation_publish", domain: "content_creation" }), config: {}, dependencies: {} }),
    (error) => error instanceof DomainDriverRegistryError && error.code === "DOMAIN_DRIVER_NOT_IMPLEMENTED",
  );
  assert.throws(
    () => registry.resolve({ workflow: workflow({ id: "office_report_delivery", domain: "office_automation" }), config: {}, dependencies: {} }),
    (error) => error instanceof DomainDriverRegistryError && error.code === "DOMAIN_DRIVER_NOT_IMPLEMENTED",
  );

  assert.equal(registry.metrics().domain_registry_content_creation_deferred, 1);
  assert.equal(registry.metrics().domain_registry_office_automation_deferred, 1);
});

test("domain registry rejects unknown domains with stable error code", () => {
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new FakeDomainDriver(),
  });

  assert.throws(
    () => registry.resolve({ workflow: workflow({ id: "unknown_flow", domain: "unknown_domain" }), config: {}, dependencies: {} }),
    (error) => error instanceof DomainDriverRegistryError && error.code === "DOMAIN_DRIVER_UNKNOWN",
  );
  assert.equal(registry.metrics().domain_registry_unknown_domain_errors, 1);
});

function workflow(input: { id: string; domain?: string }): WorkflowDefinition {
  return {
    id: input.id,
    version: "1.0",
    domain: input.domain,
    roles: {
      worker: {
        run_mode: "background_child",
        agent: "build",
        load_skills: [],
        timeout_seconds: 60,
      },
    },
    stages: {
      implementation: {
        lifecycle_state: "running",
        role: "worker",
      },
    },
  };
}
