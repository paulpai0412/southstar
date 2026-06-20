import type { ManagedAgentResourceType, ManagedAgentSessionEventType } from "./taxonomy.ts";

export type EventRef = {
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type SessionEvent = {
  eventType: ManagedAgentSessionEventType;
  actorType: "operator" | "orchestrator" | "brain" | "hand" | "evaluator" | "tool-proxy";
  runId: string;
  taskId?: string;
  sessionId: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
};

export type EventSliceQuery = {
  afterSequence?: number;
  beforeSequence?: number;
  aroundEventId?: string;
  windowBefore?: number;
  windowAfter?: number;
  eventTypes?: ManagedAgentSessionEventType[];
  taskId?: string;
  artifactRef?: string;
  correlationId?: string;
  limit?: number;
};

export type SessionCheckpoint = {
  id: string;
  runId: string;
  taskId?: string;
  sessionId: string;
  checkpointType: "task-start" | "artifact-accepted" | "before-recovery" | "operator";
  summary: string;
  eventRange: { fromSequence: number; toSequence: number };
  refs: Record<string, string[]>;
  metrics: Record<string, unknown>;
  createdAt: string;
};

export type CheckpointInput = Omit<SessionCheckpoint, "id" | "createdAt"> & {
  id?: string;
  resourceKey?: string;
};

export type SessionStore = {
  emitEvent(event: SessionEvent): Promise<EventRef>;
  getEvents(sessionId: string, query: EventSliceQuery): Promise<SessionEvent[]>;
  createCheckpoint(input: CheckpointInput): Promise<SessionCheckpoint>;
  getCheckpoint(checkpointId: string): Promise<SessionCheckpoint | null>;
};

export type BindingStatus = "provisioned" | "running" | "succeeded" | "failed" | "cancelled" | "lost" | "destroyed";

export type ManagedResourceEnvelope<
  TPayload extends Record<string, unknown>,
  TStatus extends string = BindingStatus,
> = {
  resourceType: ManagedAgentResourceType;
  resourceKey: string;
  status: TStatus;
  payload: TPayload;
  summary?: Record<string, unknown>;
};
