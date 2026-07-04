export const GENERATED_AGENT_PROFILE_WORKER_KINDS = [
  "execution_worker",
  "validation_worker",
  "repair_worker",
  "review_worker",
] as const;

export const GENERATED_AGENT_PROFILE_PROVIDERS = ["codex", "pi"] as const;

export const GENERATED_AGENT_PROFILE_MODELS = ["gpt-5", "gpt-5-codex", "pi-agent-default"] as const;

export const GENERATED_AGENT_PROFILE_THINKING_LEVELS = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const GENERATED_AGENT_PROFILE_HARNESSES = ["codex", "pi"] as const;

export const GENERATED_AGENT_PROFILE_EXECUTION_ENGINES = ["tork"] as const;

export const GENERATED_AGENT_PROFILE_IMAGES = [
  "southstar/pi-agent:local",
] as const;

export const GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT = "southstar-agent-runner";

export const GENERATED_AGENT_PROFILE_ALLOWED_VALUES = {
  workerKind: GENERATED_AGENT_PROFILE_WORKER_KINDS,
  provider: GENERATED_AGENT_PROFILE_PROVIDERS,
  model: GENERATED_AGENT_PROFILE_MODELS,
  thinkingLevel: GENERATED_AGENT_PROFILE_THINKING_LEVELS,
  harnessRef: GENERATED_AGENT_PROFILE_HARNESSES,
  execution: {
    engine: GENERATED_AGENT_PROFILE_EXECUTION_ENGINES,
    image: GENERATED_AGENT_PROFILE_IMAGES,
    commandEntrypoint: GENERATED_AGENT_PROFILE_COMMAND_ENTRYPOINT,
  },
} as const;

export type GeneratedAgentProfileRuntimeBinding = {
  provider: "pi";
  model: "pi-agent-default";
  harnessRef: "pi";
};

export function runtimeBindingForGeneratedProfileImage(image: unknown): GeneratedAgentProfileRuntimeBinding | null {
  if (image !== "southstar/pi-agent:local") return null;
  return {
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
  };
}

export function isAllowedGeneratedAgentProfileValue(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}
