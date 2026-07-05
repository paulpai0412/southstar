import type { CandidatePacket, WorkflowCompositionPlan } from "../design-library/types.ts";

export type ComposeWorkflowInput = {
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  onLlmDelta?: (text: string) => void;
};

export interface WorkflowComposer {
  compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan>;
}

export class ScriptedWorkflowComposer implements WorkflowComposer {
  private index = 0;

  constructor(private readonly plans: WorkflowCompositionPlan[]) {}

  async compose(_input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const plan = this.plans[Math.min(this.index, this.plans.length - 1)];
    this.index += 1;
    if (!plan) {
      throw new Error("ScriptedWorkflowComposer has no plans");
    }
    return structuredClone(plan);
  }
}
