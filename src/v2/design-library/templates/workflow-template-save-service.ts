import type { SouthstarDb } from "../../db/postgres.ts";
import type { WorkflowCompositionPlan } from "../types.ts";
import { parseLibraryFileContent } from "../files/library-file-parser.ts";
import { syncLibraryFileToGraph, writeLibraryFile } from "../files/library-file-store.ts";

export type SaveWorkflowTemplateDraftInput = {
  root: string;
  scope: string;
  templateId: string;
  title: string;
  status?: "draft" | "approved";
  nodes: Array<{
    id: string;
    title: string;
    agentRef: string;
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
  }>;
  edges: Array<{ from: string; to: string }>;
  libraryVersionRefs: string[];
  compositionPlan?: WorkflowCompositionPlan;
};

type LibraryDraftFile = { relativePath: string; content: string };

const TEMPLATE_ID_PATTERN = /^template\.[a-z0-9][a-z0-9.-]*$/;
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const REF_PATTERNS = {
  agentRef: /^agent\.[a-z0-9][a-z0-9._-]*$/,
  skillRefs: /^skill\.[a-z0-9][a-z0-9._-]*$/,
  toolGrantRefs: /^tool\.[a-z0-9][a-z0-9._-]*$/,
  mcpGrantRefs: /^mcp\.[a-z0-9][a-z0-9._-]*$/,
};

export async function saveWorkflowTemplateDraft(db: SouthstarDb, input: SaveWorkflowTemplateDraftInput) {
  validateInput(input);
  const status = input.status ?? "draft";
  const templateSlug = input.templateId.replace(/^template\./, "");
  const profileDrafts = input.nodes.map((node) => {
    const profileId = `profile.generated.${templateSlug}.${node.id}`;
    const relativePath = `profiles/generated/${templateSlug}/${node.id}.profile.yaml`;
    return {
      relativePath,
      content: profileYaml({ ...node, profileId, scope: input.scope, status, templateId: input.templateId }),
    };
  });
  const templatePath = `templates/saved/${templateSlug}.workflow.yaml`;
  const templateDraft = { relativePath: templatePath, content: templateYaml({ ...input, status }, templateSlug) };
  const drafts = [...profileDrafts, templateDraft];
  validateDrafts(drafts);

  for (const draft of drafts) {
    await writeLibraryFile({ root: input.root, relativePath: draft.relativePath, content: draft.content });
  }

  const profiles = [];
  for (const profileDraft of profileDrafts) {
    profiles.push({
      relativePath: profileDraft.relativePath,
      sync: await syncLibraryFileToGraph(db, { root: input.root, relativePath: profileDraft.relativePath }),
    });
  }
  const template = {
    relativePath: templatePath,
    sync: await syncLibraryFileToGraph(db, { root: input.root, relativePath: templatePath }),
  };
  return { template, profiles };
}

function profileYaml(
  input: SaveWorkflowTemplateDraftInput["nodes"][number] & { profileId: string; scope: string; status: "draft" | "approved"; templateId: string },
): string {
  return `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: ${yamlScalar(input.profileId)}
title: ${yamlScalar(input.title)}
scope: ${yamlScalar(input.scope)}
status: ${input.status}
agentRef: ${yamlScalar(input.agentRef)}
skillRefs:
${yamlList(input.skillRefs)}
toolGrantRefs:
${yamlList(input.toolGrantRefs)}
mcpGrantRefs:
${yamlList(input.mcpGrantRefs)}
instructionRefs: []
source:
  kind: ${yamlScalar("workflow-generate-save")}
  templateRef: ${yamlScalar(input.templateId)}
  nodeId: ${yamlScalar(input.id)}
`;
}

function templateYaml(input: SaveWorkflowTemplateDraftInput, templateSlug: string): string {
  return `schemaVersion: southstar.library.workflow_template_file.v1
id: ${yamlScalar(input.templateId)}
title: ${yamlScalar(input.title)}
scope: ${yamlScalar(input.scope)}
status: ${input.status ?? "draft"}
libraryVersionRefs:
${yamlList(input.libraryVersionRefs)}
profileRefs:
${yamlList(input.nodes.map((node) => `profile.generated.${templateSlug}.${node.id}`))}
${input.compositionPlan ? `compositionPlanJsonBase64: ${yamlScalar(Buffer.from(JSON.stringify(input.compositionPlan), "utf8").toString("base64"))}\n` : ""}\
nodes:
${input.nodes.map((node) => `  - id: ${yamlScalar(node.id)}\n    title: ${yamlScalar(node.title)}\n    profileRef: ${yamlScalar(`profile.generated.${templateSlug}.${node.id}`)}`).join("\n")}
edges:
${input.edges.map((edge) => `  - from: ${yamlScalar(edge.from)}\n    to: ${yamlScalar(edge.to)}`).join("\n") || "  []"}
`;
}

function yamlList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `  - ${yamlScalar(value)}`).join("\n") : "  []";
}

function validateInput(input: SaveWorkflowTemplateDraftInput): void {
  if (!TEMPLATE_ID_PATTERN.test(input.templateId) || input.templateId.includes("..")) {
    throw new Error("templateId must match template.<slug>");
  }
  const templateSlug = input.templateId.replace(/^template\./, "");
  if (!NODE_ID_PATTERN.test(templateSlug)) {
    throw new Error("templateId must match template.<slug>");
  }
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) throw new Error(`node id must be path-safe: ${node.id}`);
    if (nodeIds.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    validateRef("agentRef", node.agentRef, REF_PATTERNS.agentRef);
    for (const skillRef of node.skillRefs) validateRef("skillRefs", skillRef, REF_PATTERNS.skillRefs);
    for (const toolRef of node.toolGrantRefs) validateRef("toolGrantRefs", toolRef, REF_PATTERNS.toolGrantRefs);
    for (const mcpRef of node.mcpGrantRefs) validateRef("mcpGrantRefs", mcpRef, REF_PATTERNS.mcpGrantRefs);
  }
  for (const edge of input.edges) {
    if (!nodeIds.has(edge.from)) throw new Error(`edge.from references unknown node: ${edge.from}`);
    if (!nodeIds.has(edge.to)) throw new Error(`edge.to references unknown node: ${edge.to}`);
  }
}

function validateRef(field: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value) || value.includes("..")) throw new Error(`${field} is not a valid library ref: ${value}`);
}

function validateDrafts(drafts: LibraryDraftFile[]): void {
  for (const draft of drafts) {
    const parsed = parseLibraryFileContent({ path: `library/${draft.relativePath}`, content: draft.content });
    if (!parsed.ok) {
      throw new Error(`generated library file is invalid: ${draft.relativePath}: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }
  }
}

function yamlScalar(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`YAML scalar cannot contain a newline: ${value}`);
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(`YAML scalar cannot contain both quote types: ${value}`);
}
