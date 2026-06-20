import type { ContextPacket, ManagedContextSourceRefs } from "./types.ts";

export function attachManagedContextSourceRefs(packet: ContextPacket, refs: ManagedContextSourceRefs): ContextPacket {
  return {
    ...packet,
    managedSourceRefs: refs,
  };
}
