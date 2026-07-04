import type { ComposeWorkflowInput, WorkflowComposer } from "./composer.ts";

export type WorkflowComposerMode = "llm";

export type ResolveWorkflowComposerInput = {
  composerMode?: WorkflowComposerMode;
};

export type WorkflowComposerRegistryOptions = {
  llmComposer?: WorkflowComposer;
};

export type WorkflowComposerRegistry = {
  resolve(input: ResolveWorkflowComposerInput): WorkflowComposer;
};

export function createWorkflowComposerRegistry(options: WorkflowComposerRegistryOptions = {}): WorkflowComposerRegistry {
  return {
    resolve(input) {
      const mode = input.composerMode ?? "llm";
      if (mode === "llm") {
        if (!options.llmComposer) {
          throw new Error("LLM workflow composer is not configured");
        }
        return options.llmComposer;
      }
      throw new Error(`Unknown workflow composer mode: ${String(mode)}`);
    },
  };
}
