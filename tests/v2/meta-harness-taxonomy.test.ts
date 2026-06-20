import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGED_AGENT_RESOURCE_TYPES,
  MANAGED_AGENT_SESSION_EVENT_TYPES,
  assertManagedAgentResourceType,
  assertManagedAgentSessionEventType,
} from "../../src/v2/meta-harness/taxonomy.ts";

test("managed-agent taxonomy includes required resource and event types", () => {
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("brain_binding"));
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("hand_binding"));
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("session_checkpoint"));
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("tool_proxy_call"));
  assert.ok(MANAGED_AGENT_SESSION_EVENT_TYPES.includes("brain.woke"));
  assert.ok(MANAGED_AGENT_SESSION_EVENT_TYPES.includes("hand.execute_completed"));
  assert.ok(MANAGED_AGENT_SESSION_EVENT_TYPES.includes("recovery.decision_recorded"));
});

test("managed-agent taxonomy rejects unknown strings", () => {
  assert.equal(assertManagedAgentResourceType("brain_binding"), "brain_binding");
  assert.equal(assertManagedAgentSessionEventType("brain.woke"), "brain.woke");
  assert.throws(() => assertManagedAgentResourceType("random"));
  assert.throws(() => assertManagedAgentSessionEventType("random.event"));
});
