import { DeterministicFixtureComposer } from "./composer.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "./composer.ts";

export type WorkflowComposerMode = "fixture" | "llm" | "llm-with-fixture-fallback";

export type ResolveWorkflowComposerInput = {
  composerMode?: WorkflowComposerMode;
};

export type WorkflowComposerRegistryOptions = {
  llmComposer?: WorkflowComposer;
  fixtureComposer?: WorkflowComposer;
};

export type WorkflowComposerRegistry = {
  resolve(input: ResolveWorkflowComposerInput): WorkflowComposer;
};

export function createWorkflowComposerRegistry(options: WorkflowComposerRegistryOptions = {}): WorkflowComposerRegistry {
  const fixtureComposer = options.fixtureComposer ?? new DeterministicFixtureComposer();
  return {
    resolve(input) {
      const mode = input.composerMode ?? "llm";
      if (mode === "fixture") {
        return fixtureComposer;
      }
      if (mode === "llm") {
        if (!options.llmComposer) {
          throw new Error("LLM workflow composer is not configured");
        }
        return options.llmComposer;
      }
      if (mode === "llm-with-fixture-fallback") {
        if (!options.llmComposer) {
          return fixtureComposer;
        }
        return new FallbackWorkflowComposer(options.llmComposer, fixtureComposer);
      }
      throw new Error(`Unknown workflow composer mode: ${String(mode)}`);
    },
  };
}

class FallbackWorkflowComposer implements WorkflowComposer {
  private fallbackUsed = false;

  constructor(
    private readonly primary: WorkflowComposer,
    private readonly fallback: WorkflowComposer,
  ) {}

  async compose(input: ComposeWorkflowInput) {
    try {
      return await this.primary.compose(input);
    } catch {
      this.fallbackUsed = true;
      return await this.fallback.compose(input);
    }
  }

  wasFallbackUsed(): boolean {
    return this.fallbackUsed;
  }
}
