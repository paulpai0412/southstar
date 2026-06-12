import type { PlanBundle, SouthstarWorkflowManifest } from "./types.ts";

export type { PlanBundle, SouthstarWorkflowManifest };

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};
