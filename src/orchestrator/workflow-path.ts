import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "../config/schema.ts";

export function resolveProductionWorkflowPath(input: {
  config: RuntimeConfig;
  workflowPath?: string;
  packageRoot?: string;
}): string {
  if (input.workflowPath) return input.workflowPath;
  if (input.config.workflow.path) {
    return isAbsolute(input.config.workflow.path)
      ? input.config.workflow.path
      : resolve(input.config.project.root, input.config.workflow.path);
  }
  return resolveBuiltinWorkflowPath({
    workflowId: input.config.workflow.id,
    packageRoot: input.packageRoot,
  });
}

export function resolveBuiltinWorkflowPath(input: {
  workflowId: string;
  packageRoot?: string;
}): string {
  const workflowFile = builtinWorkflowFiles[input.workflowId];
  if (!workflowFile) {
    throw new Error(`No builtin workflow path registered for ${input.workflowId}`);
  }
  return join(input.packageRoot ?? packageRoot(), workflowFile);
}

const builtinWorkflowFiles: Record<string, string> = {
  issue_to_pr_release: "tests/fixtures/workflows/issue-to-pr-release.yaml",
};

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}
