export const MANAGED_AGENT_RESOURCE_TYPES = [
  "session",
  "session_checkpoint",
  "brain_binding",
  "hand_binding",
  "hand_snapshot",
  "context_packet",
  "context_transform",
  "task_envelope",
  "artifact_ref",
  "artifact_blob",
  "evaluator_result",
  "recovery_decision",
  "recovery_execution",
  "tool_grant",
  "tool_proxy_call",
  "vault_lease",
  "executor_binding",
  "executor_reconcile_result",
] as const;

export type ManagedAgentResourceType = typeof MANAGED_AGENT_RESOURCE_TYPES[number];

export const MANAGED_AGENT_SESSION_EVENT_TYPES = [
  "session.created",
  "brain.woke",
  "brain.failed",
  "brain.cancelled",
  "context.packet_built",
  "context.events_read",
  "hand.provisioned",
  "hand.execute_requested",
  "hand.execute_completed",
  "hand.failed",
  "hand.snapshot_created",
  "artifact.created",
  "artifact.accepted",
  "artifact.rejected",
  "evaluator.completed",
  "checkpoint.created",
  "recovery.decision_recorded",
  "recovery.execution_submitted",
  "tool_proxy.called",
  "vault_lease.issued",
  "operator.steering_received",
] as const;

export type ManagedAgentSessionEventType = typeof MANAGED_AGENT_SESSION_EVENT_TYPES[number];

export function assertManagedAgentResourceType(value: string): ManagedAgentResourceType {
  if (MANAGED_AGENT_RESOURCE_TYPES.includes(value as ManagedAgentResourceType)) {
    return value as ManagedAgentResourceType;
  }
  throw new Error(`unknown managed-agent resource type: ${value}`);
}

export function assertManagedAgentSessionEventType(value: string): ManagedAgentSessionEventType {
  if (MANAGED_AGENT_SESSION_EVENT_TYPES.includes(value as ManagedAgentSessionEventType)) {
    return value as ManagedAgentSessionEventType;
  }
  throw new Error(`unknown managed-agent session event type: ${value}`);
}
