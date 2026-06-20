import type { BrainSessionBinding } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandBinding } from "../hands/types.ts";
import { listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export async function persistBrainBindingPg(db: SouthstarDb, binding: BrainSessionBinding): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: binding.id,
    resourceType: "brain_binding",
    resourceKey: binding.id,
    runId: binding.runId,
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    scope: "brain",
    status: binding.status,
    title: `Brain ${binding.providerId} for ${binding.taskId}`,
    payload: binding,
    summary: { providerId: binding.providerId, taskId: binding.taskId, contextPacketId: binding.contextPacketId },
  });
}

export async function persistHandBindingPg(db: SouthstarDb, binding: HandBinding): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: binding.id,
    resourceType: "hand_binding",
    resourceKey: binding.id,
    runId: binding.runId,
    taskId: binding.taskId,
    scope: "hand",
    status: binding.status,
    title: `Hand ${binding.providerId}:${binding.handName} for ${binding.taskId}`,
    payload: binding,
    summary: { providerId: binding.providerId, taskId: binding.taskId, handName: binding.handName },
  });
}

export async function listManagedBindingsForRunPg(
  db: SouthstarDb,
  runId: string,
): Promise<{ brainBindings: BrainSessionBinding[]; handBindings: HandBinding[] }> {
  const brain = await listResourcesPg(db, { resourceType: "brain_binding" });
  const hand = await listResourcesPg(db, { resourceType: "hand_binding" });
  return {
    brainBindings: brain.filter((item) => item.runId === runId).map((item) => item.payload as BrainSessionBinding),
    handBindings: hand.filter((item) => item.runId === runId).map((item) => item.payload as HandBinding),
  };
}
