import type { PlanBundle } from "../manifests/types.ts";

export type PlannerContext = {
  goalPrompt: string;
  schemaVersion: "southstar.v2";
  availableHarnesses: string[];
  validationIssues?: Array<{ path: string; message: string }>;
};

export type PiPlannerClient = {
  generate(prompt: string): Promise<string>;
};

export type PiPlannerResult = {
  bundle: PlanBundle;
  rawText: string;
};
