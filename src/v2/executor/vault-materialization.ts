import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnyTaskEnvelope, TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";

export type VaultRuntimeMaterialization = {
  hostEnvDir?: string;
  containerEnvDir?: string;
  env: Record<string, string>;
};

export async function materializeVaultRuntime(
  envelope: AnyTaskEnvelope,
  input: { runRoot: string; envelopeBasePath: string },
  env: Record<string, string | undefined> = process.env,
): Promise<VaultRuntimeMaterialization> {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return { env: {} };
  const bindings = vaultEnvBindings(envelope);
  if (bindings.length === 0) {
    return mcpRuntimeConfigEnv(envelope, input.envelopeBasePath);
  }

  const taskDir = resolve(input.runRoot, envelope.runId, envelope.taskId);
  const hostEnvDir = resolve(taskDir, "vault", "env");
  const containerEnvDir = `${input.envelopeBasePath}/${envelope.runId}/${envelope.taskId}/vault/env`;
  await mkdir(hostEnvDir, { recursive: true, mode: 0o700 });

  for (const binding of bindings) {
    const secretValue = resolveSecretValue(binding, env);
    const target = join(hostEnvDir, binding.name);
    await writeFile(target, secretValue, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600);
  }

  return {
    hostEnvDir,
    containerEnvDir,
    env: {
      ...mcpRuntimeConfigEnv(envelope, input.envelopeBasePath).env,
      SOUTHSTAR_VAULT_ENV_DIR: containerEnvDir,
    },
  };
}

function vaultEnvBindings(envelope: TaskEnvelopeV2): Array<{ name: string; leaseRef: string; key?: string }> {
  const seen = new Set<string>();
  const bindings = [];
  for (const server of envelope.mcpRuntimeConfig?.servers ?? []) {
    for (const binding of server.envFromVault) {
      validateEnvName(binding.name);
      const key = `${binding.name}:${binding.leaseRef}:${binding.key ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push(binding);
    }
  }
  return bindings;
}

function resolveSecretValue(
  binding: { name: string; leaseRef: string; key?: string },
  env: Record<string, string | undefined>,
): string {
  const candidates = [
    `SOUTHSTAR_VAULT_${envSlug(binding.leaseRef)}${binding.key ? `_${envSlug(binding.key)}` : ""}`,
    `SOUTHSTAR_SECRET_${envSlug(binding.leaseRef)}${binding.key ? `_${envSlug(binding.key)}` : ""}`,
    binding.name,
  ];
  for (const candidate of candidates) {
    const value = env[candidate];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`missing secret material for vault lease ${binding.leaseRef}; expected one of ${candidates.join(", ")}`);
}

function mcpRuntimeConfigEnv(envelope: TaskEnvelopeV2, envelopeBasePath: string): VaultRuntimeMaterialization {
  if (!envelope.mcpRuntimeConfig) return { env: {} };
  return {
    env: {
      SOUTHSTAR_MCP_RUNTIME_CONFIG: `${envelopeBasePath}/${envelope.runId}/${envelope.taskId}/mcp/runtime-config.json`,
    },
  };
}

function validateEnvName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid vault env binding name: ${name}`);
  }
}

function envSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}
