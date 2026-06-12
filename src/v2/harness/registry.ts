import type { AgentHarness } from "./types.ts";

export class HarnessRegistry {
  private readonly harnesses = new Map<string, AgentHarness>();

  register(harness: AgentHarness): void {
    this.harnesses.set(harness.id, harness);
  }

  get(id: string): AgentHarness {
    const harness = this.harnesses.get(id);
    if (!harness) {
      throw new Error(`unknown harness: ${id}`);
    }
    return harness;
  }
}
