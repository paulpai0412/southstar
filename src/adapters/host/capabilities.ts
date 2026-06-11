import type { RoleDefinition } from "../../types/workflow.ts";

export const productionHostNames = ["codex", "opencode", "pi"] as const;
export type ProductionHostName = typeof productionHostNames[number];

export const hostCapabilityNames = [
  "agent",
  "model",
  "load_skills",
  "tools",
  "reasoning_effort",
  "mcp_servers",
] as const;
export type HostCapabilityName = typeof hostCapabilityNames[number];

export interface HostCapabilityReport {
  host: ProductionHostName;
  applied: HostCapabilityName[];
  defaulted: HostCapabilityName[];
  unsupported: HostCapabilityName[];
}

export interface HostExecutionContext {
  prompt: string;
  working_directory: string;
  issue_number?: number;
  issue_url?: string;
  repo?: string;
  branch?: string;
  pr_number?: number;
  pr_url?: string;
}

export interface HostExecutionRequest {
  host: ProductionHostName;
  role_name: string;
  role: RoleDefinition;
  execution: HostExecutionContext;
}

export interface HostModelReference {
  provider?: string;
  modelId: string;
}

export function isProductionHostName(value: string): value is ProductionHostName {
  return (productionHostNames as readonly string[]).includes(value);
}

export function buildCapabilityReport(input: {
  host: ProductionHostName;
  applied?: HostCapabilityName[];
  defaulted?: HostCapabilityName[];
  unsupported?: HostCapabilityName[];
}): HostCapabilityReport {
  return {
    host: input.host,
    applied: uniqueCapabilities(input.applied ?? []),
    defaulted: uniqueCapabilities(input.defaulted ?? []),
    unsupported: uniqueCapabilities(input.unsupported ?? []),
  };
}

export function parseHostModelReference(value: string | undefined): HostModelReference | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { modelId: value };
  return {
    provider: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

function uniqueCapabilities(values: HostCapabilityName[]): HostCapabilityName[] {
  return [...new Set(values)];
}
