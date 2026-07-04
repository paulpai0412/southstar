import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowAgentSummary, WorkflowLibrary, WorkflowTemplateSummary } from "../../../../lib/workflow/types";
import { buildWorkflowV2Url, workflowV2BlockedResponse } from "../../../../lib/workflow/v2-api";

type V2Envelope<T> = {
  ok?: boolean;
  kind?: string;
  result?: T;
};

type LibraryGraphNode = {
  objectKey?: string;
  objectKind?: string;
  status?: string;
  title?: string;
  scope?: string;
};

type LibraryGraphReadModel = {
  nodes?: LibraryGraphNode[];
};

type LibraryObjectDetail = {
  object?: {
    objectKey?: string;
    objectKind?: string;
    status?: string;
    state?: Record<string, unknown>;
  };
};

export async function GET(request: NextRequest) {
  try {
    const domain = request.nextUrl.searchParams.get("domain") ?? "software";
    const graph = await fetchRuntimeJson<LibraryGraphReadModel>(
      `/api/v2/library/graph?scope=${encodeURIComponent(domain)}&status=approved`,
    );
    const templateNodes = (graph.nodes ?? [])
      .filter((node) => node.objectKind === "workflow_template" && node.status === "approved" && node.objectKey);

    const details = await Promise.all(templateNodes.map((node) => (
      fetchRuntimeJson<LibraryObjectDetail>(`/api/v2/library/objects/${encodeURIComponent(node.objectKey!)}`)
    )));
    const profileRefs = uniquePreservingOrder(details.flatMap((detail) => profileRefsFromTemplateDetail(detail)));
    const profileDetails = await Promise.all(profileRefs.map((profileRef) => (
      fetchRuntimeJson<LibraryObjectDetail>(`/api/v2/library/objects/${encodeURIComponent(profileRef)}`).catch(() => null)
    )));
    const profileDetailsByRef = new Map<string, LibraryObjectDetail>();
    for (const detail of profileDetails) {
      if (!detail?.object?.objectKey) continue;
      profileDetailsByRef.set(detail.object.objectKey, detail);
    }
    const supportRefs = uniquePreservingOrder(profileDetails.flatMap((detail) => refsFromProfileDetail(detail)));
    const supportDetails = await Promise.all(supportRefs.map((objectRef) => (
      fetchRuntimeJson<LibraryObjectDetail>(`/api/v2/library/objects/${encodeURIComponent(objectRef)}`).catch(() => null)
    )));
    const supportDetailsByRef = new Map<string, LibraryObjectDetail>();
    for (const detail of supportDetails) {
      if (!detail?.object?.objectKey) continue;
      supportDetailsByRef.set(detail.object.objectKey, detail);
    }

    return NextResponse.json({ library: await workflowLibraryFromGraph(domain, details, profileDetailsByRef, supportDetailsByRef) });
  } catch (error) {
    if (error instanceof Error && error.message === "Southstar v2 workflow API is not configured") {
      return workflowV2BlockedResponse();
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

async function fetchRuntimeJson<T>(pathname: string): Promise<T> {
  const response = await fetch(buildWorkflowV2Url(pathname), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`workflow library graph request failed: HTTP ${response.status}`);
  const payload = await response.json() as V2Envelope<T> | T;
  if (isRecord(payload) && "result" in payload) return payload.result as T;
  return payload as T;
}

async function workflowLibraryFromGraph(
  domain: string,
  details: LibraryObjectDetail[],
  profileDetailsByRef: Map<string, LibraryObjectDetail>,
  supportDetailsByRef: Map<string, LibraryObjectDetail>,
): Promise<WorkflowLibrary> {
  const templates = details
    .map((detail) => workflowTemplateFromDetail(domain, detail))
    .filter((template): template is WorkflowTemplateSummary => Boolean(template))
    .sort((left, right) => left.title.localeCompare(right.title));
  const profileRefs = uniquePreservingOrder(details.flatMap((detail) => profileRefsFromTemplateDetail(detail)));
  const agents = await Promise.all(profileRefs.map((profileRef) => workflowAgentFromProfileRef(
    domain,
    profileRef,
    profileDetailsByRef.get(profileRef),
    supportDetailsByRef,
  )));
  return {
    domains: [{
      id: domain,
      label: titleCase(domain),
      workflowTemplates: templates,
      agents,
      resources: [],
    }],
  };
}

function workflowTemplateFromDetail(domain: string, detail: LibraryObjectDetail): WorkflowTemplateSummary | null {
  const object = detail.object;
  if (!object?.objectKey || object.objectKind !== "workflow_template" || object.status !== "approved") return null;
  const state = object.state ?? {};
  const nodes = arrayOfRecords(state.nodes);
  const profileRefs = stringArray(state.profileRefs);
  const stageRefs = nodes.length > 0
    ? nodes.map((node) => stringValue(node.id)).filter((value): value is string => Boolean(value))
    : stringArray(state.roleRefs);
  const nodeProfileRefs = nodes
    .map((node) => stringValue(node.profileRef))
    .filter((value): value is string => Boolean(value));
  const agentRefs = uniquePreservingOrder([...nodeProfileRefs, ...profileRefs].map(agentRefFromProfileRef));
  return {
    id: object.objectKey,
    domainId: stringValue(state.scope) ?? domain,
    title: stringValue(state.title) ?? object.objectKey,
    description: stringValue(state.description) ?? `Graph-backed workflow template from ${object.objectKey}.`,
    agentRefs,
    stageRefs,
    status: "approved",
  };
}

function profileRefsFromTemplateDetail(detail: LibraryObjectDetail): string[] {
  const state = detail.object?.state ?? {};
  const nodes = arrayOfRecords(state.nodes);
  const nodeProfileRefs = nodes
    .map((node) => stringValue(node.profileRef))
    .filter((value): value is string => Boolean(value));
  return uniquePreservingOrder([...nodeProfileRefs, ...stringArray(state.profileRefs)]);
}

async function workflowAgentFromProfileRef(
  domain: string,
  profileRef: string,
  profileDetail: LibraryObjectDetail | undefined,
  supportDetailsByRef: Map<string, LibraryObjectDetail>,
): Promise<WorkflowAgentSummary> {
  const agentRef = agentRefFromProfileRef(profileRef);
  const segment = agentRef.replace(/^agent\./, "");
  const state = profileDetail?.object?.state ?? {};
  const sourcePath = stringValue(state.sourcePath);
  const skillResourcePaths = uniquePreservingOrder((await Promise.all(
    stringArray(state.skillRefs).map((skillRef) => resourcePathsForSkill(supportDetailsByRef.get(skillRef))),
  )).flat());
  const mcpResourcePaths = uniquePreservingOrder(stringArray(state.mcpGrantRefs)
    .map((mcpRef) => graphObjectResourcePath(supportDetailsByRef.get(mcpRef)))
    .filter((value): value is string => Boolean(value)));
  const policyResourcePaths = uniquePreservingOrder([
    ...stringArray(state.toolGrantRefs).map((toolRef) => graphObjectResourcePath(supportDetailsByRef.get(toolRef))),
    ...stringArray(state.instructionRefs).map((instructionRef) => graphObjectResourcePath(supportDetailsByRef.get(instructionRef))),
  ].filter((value): value is string => Boolean(value)));
  const instructionResourcePath = agentsMdResourcePathForAgent(supportDetailsByRef.get(stringValue(state.agentRef) ?? ""));
  return {
    id: agentRef,
    domainId: domain,
    label: titleCase(segment.replace(/^generated-/, "")),
    role: segment,
    defaultProfileRef: profileRef,
    profileResourcePath: sourcePath ?? `${domain}/profiles/${segment}.yaml`,
    instructionResourcePath: instructionResourcePath ?? "",
    skillResourcePaths,
    mcpResourcePaths,
    policyResourcePaths,
  };
}

function refsFromProfileDetail(detail: LibraryObjectDetail | null): string[] {
  const state = detail?.object?.state ?? {};
  return [
    ...stringArray(state.skillRefs),
    ...stringArray(state.mcpGrantRefs),
    ...stringArray(state.toolGrantRefs),
    ...stringArray(state.instructionRefs),
    ...(stringValue(state.agentRef) ? [stringValue(state.agentRef)!] : []),
  ];
}

function agentsMdResourcePathForAgent(detail: LibraryObjectDetail | undefined): string | undefined {
  const object = detail?.object;
  if (!object?.objectKey || object.objectKind !== "agent_definition") return undefined;
  return `library/generated-agents/${object.objectKey}/AGENTS.md`;
}

async function resourcePathsForSkill(detail: LibraryObjectDetail | undefined): Promise<string[]> {
  const sourcePath = stringValue(detail?.object?.state?.sourcePath);
  if (!sourcePath) return [];
  const paths = [sourcePath];
  const skillDir = sourcePath.replace(/\.skill\.md$/, "");
  if (skillDir !== sourcePath) {
    paths.push(...await listLibraryFilesUnder(skillDir));
  }
  return uniquePreservingOrder(paths);
}

async function listLibraryFilesUnder(relativeDir: string): Promise<string[]> {
  const root = southstarRepoRoot();
  const dirPath = path.resolve(root, relativeDir);
  if (!dirPath.startsWith(`${root}${path.sep}`)) return [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const childRelative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) return await listLibraryFilesUnder(childRelative);
      return entry.isFile() ? [childRelative] : [];
    }));
    return nested.flat().sort();
  } catch {
    return [];
  }
}

function southstarRepoRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === "web" ? path.dirname(cwd) : cwd;
}

function graphObjectResourcePath(detail: LibraryObjectDetail | undefined): string | undefined {
  const objectKey = detail?.object?.objectKey;
  if (!objectKey) return undefined;
  const sourcePath = stringValue(detail.object?.state?.sourcePath);
  return sourcePath ?? `library/objects/${objectKey}.json`;
}

function agentRefFromProfileRef(profileRef: string): string {
  const segment = profileRef
    .replace(/^profile\./, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `agent.${segment || "generated-profile"}`;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function titleCase(value: string): string {
  const words = value.split(/[-_.\s]+/).filter(Boolean);
  return words.length > 0
    ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
    : "Software";
}
