import type {
  CandidatePacket,
  WorkflowCompositionPatch,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
} from "../design-library/types.ts";
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

export type ComposeWorkflowRepairInput = ComposeWorkflowInput & {
  baseComposition: WorkflowCompositionPlan;
  validationIssues: WorkflowCompositionValidationIssue[];
};

export interface WorkflowComposer {
  compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan>;
  /** Return one bounded patch against the already validated/validated-against plan. */
  repair?(input: ComposeWorkflowRepairInput): Promise<WorkflowCompositionPatch>;
}
