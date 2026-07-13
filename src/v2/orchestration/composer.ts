import type { CandidatePacket, WorkflowCompositionPlan } from "../design-library/types.ts";
import type { GoalDesignPackage } from "./goal-design.ts";
import type { GoalContractV1 } from "./goal-contract.ts";

export type ComposeWorkflowInput = {
  goalPrompt: string;
  goalContract: GoalContractV1;
  goalDesignPackage?: GoalDesignPackage;
  candidatePacket: CandidatePacket;
  cwd?: string;
  onLlmDelta?: (text: string) => void;
};

export interface WorkflowComposer {
  compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan>;
}
