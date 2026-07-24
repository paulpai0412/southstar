import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TaskEnvelopeV2 } from "./task-envelope.ts";
import type { ContextBlock } from "../context/types.ts";

export type TaskMaterializerOptions = {
  runRoot?: string;
};

export type TaskMaterialization = {
  taskDir: string;
  envelopePath: string;
};

type RuntimeBundleManifest = {
  schemaVersion: "southstar.runtime_bundle_manifest.v1";
  runId: string;
  taskId: string;
  defaultContainerBasePath: string;
  files: Array<{
    label: string;
    relativePath: string;
    kind:
      | "envelope"
      | "context"
      | "agents_md"
      | "agent_profile"
      | "tool_policy"
      | "mcp_grants"
      | "mcp_runtime_config"
      | "skill_instruction"
      | "skill_metadata"
      | "skill_bundle";
  }>;
  policy: {
    toolsAreGrantPolicyOnly: boolean;
    mcpEntriesAreGrantPolicyOnly: boolean;
  };
};

const DEFAULT_RUN_ROOT = "/tmp/southstar-runs";

export async function materializeTaskEnvelope(
  envelope: TaskEnvelopeV2,
  options: TaskMaterializerOptions = {},
): Promise<TaskMaterialization> {
  const runRoot = options.runRoot ?? DEFAULT_RUN_ROOT;
  const runDir = resolveChildDir(runRoot, envelope.runId, "run id");
  const taskId = envelope.taskId;
  const taskDir = resolveChildDir(runDir, taskId, "task id");
  const envelopePath = join(taskDir, "envelope.json");
  const manifestFiles: RuntimeBundleManifest["files"] = [{ label: "Task envelope", relativePath: "envelope.json", kind: "envelope" }];
  await mkdir(taskDir, { recursive: true });
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  await writeFile(join(taskDir, "context-packet.json"), JSON.stringify(envelope.contextPacket, null, 2));
  manifestFiles.push({ label: "Context packet", relativePath: "context-packet.json", kind: "context" });
  const agentsMd = renderAgentsMd(envelope.contextPacket.agentsMdBlocks);
  if (agentsMd) {
    await writeFile(join(taskDir, "AGENTS.md"), agentsMd);
    manifestFiles.push({ label: "Agent instructions", relativePath: "AGENTS.md", kind: "agents_md" });
  }
  await mkdir(join(taskDir, "agent-profile"), { recursive: true });
  await writeFile(join(taskDir, "agent-profile", "profile.json"), JSON.stringify(envelope.agentProfile, null, 2));
  manifestFiles.push({ label: "Agent profile", relativePath: "agent-profile/profile.json", kind: "agent_profile" });
  if (envelope.toolProxyPolicy) {
    await mkdir(join(taskDir, "tools"), { recursive: true });
    await writeFile(join(taskDir, "tools", "tool-policy.json"), JSON.stringify(envelope.toolProxyPolicy, null, 2));
    manifestFiles.push({ label: "Tool proxy policy", relativePath: "tools/tool-policy.json", kind: "tool_policy" });
  }
  await mkdir(join(taskDir, "mcp"), { recursive: true });
  await writeFile(join(taskDir, "mcp", "grants.json"), JSON.stringify(envelope.mcpGrants, null, 2));
  manifestFiles.push({ label: "MCP grants", relativePath: "mcp/grants.json", kind: "mcp_grants" });
  if (envelope.mcpRuntimeConfig) {
    await writeFile(join(taskDir, "mcp", "runtime-config.json"), JSON.stringify(envelope.mcpRuntimeConfig, null, 2));
    manifestFiles.push({ label: "MCP runtime config", relativePath: "mcp/runtime-config.json", kind: "mcp_runtime_config" });
  }
  const skillsRoot = join(taskDir, "skills");
  for (const skill of envelope.skills) {
    const skillDir = resolveSkillDir(skillsRoot, skill.skillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skill.instructions);
    await writeFile(join(skillDir, "skill.json"), JSON.stringify(skill, null, 2));
    manifestFiles.push(
      { label: `Skill instructions ${skill.skillId}`, relativePath: `skills/${skill.skillId}/SKILL.md`, kind: "skill_instruction" },
      { label: `Skill metadata ${skill.skillId}`, relativePath: `skills/${skill.skillId}/skill.json`, kind: "skill_metadata" },
    );
    for (const file of skill.bundleFiles ?? []) {
      const filePath = resolveChildPath(skillDir, file.relativePath, "skill bundle file");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from(file.contentBase64, "base64"));
      manifestFiles.push({
        label: `Skill bundle ${skill.skillId}`,
        relativePath: `skills/${skill.skillId}/${file.relativePath}`,
        kind: "skill_bundle",
      });
    }
  }
  const manifest: RuntimeBundleManifest = {
    schemaVersion: "southstar.runtime_bundle_manifest.v1",
    runId: envelope.runId,
    taskId,
    defaultContainerBasePath: `/southstar-runs/${envelope.runId}/${taskId}`,
    files: manifestFiles,
    policy: {
      toolsAreGrantPolicyOnly: true,
      mcpEntriesAreGrantPolicyOnly: true,
    },
  };
  await writeFile(join(taskDir, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
  return { taskDir, envelopePath };
}

export async function cleanupTaskMaterialization(materialization: TaskMaterialization): Promise<void> {
  await rm(materialization.taskDir, { recursive: true, force: true });
}

function renderAgentsMd(blocks: ContextBlock[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const title = typeof (block as { title?: unknown }).title === "string" && (block as { title: string }).title.length > 0
        ? (block as { title: string }).title
        : "Agent Instructions";
      const text = typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text.trim() : "";
      if (!text) return "";
      return [`# ${title}`, "", text].join("\n");
    })
    .filter((section) => section.length > 0)
    .join("\n\n")
    .concat("\n");
}

function resolveSkillDir(skillsRoot: string, skillId: string): string {
  return resolveChildDir(skillsRoot, skillId, "skill id");
}

function resolveChildPath(parentDir: string, childPath: string, label: string): string {
  if (!childPath || childPath.includes("\0")) {
    throw new Error(`invalid ${label}: ${childPath}`);
  }
  const root = resolve(parentDir);
  const target = resolve(root, childPath);
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`invalid ${label}: ${childPath}`);
  }
  return target;
}

function resolveChildDir(parentDir: string, childName: string, label: string): string {
  if (!childName || childName.includes("\0")) {
    throw new Error(`invalid ${label}: ${childName}`);
  }
  const root = resolve(parentDir);
  const target = resolve(root, childName);
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`invalid ${label}: ${childName}`);
  }
  return target;
}
