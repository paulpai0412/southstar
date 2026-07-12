import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { LibraryDefinitionKind, LibraryDefinitionStatus, LibraryEdgeType, WorkflowCompositionPlan } from "../design-library/types.ts";
import {
  applyLibraryObjectLifecycleAction,
  type LibraryObjectLifecycleAction,
} from "../design-library/lifecycle/library-object-lifecycle.ts";
import { asImportSource } from "../design-library/importers/library-import-extractor.ts";
import {
  approveLibraryImportDraft,
  createLibraryImportDraft,
  installLibraryImportCandidates,
} from "../design-library/importers/library-import-draft-store.ts";
import {
  composeNodeProfileDraft,
  saveNodeProfileDraft,
  type NodeProfileDraft,
} from "../design-library/profile-composer/node-profile-draft-service.ts";
import { validateGeneratedNodeProfile } from "../design-library/profile-composer/generated-profile-validator.ts";
import { deleteLibraryObject, findLibraryEdgesFrom, findLibraryEdgesTo, findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import {
  saveWorkflowTemplateDraft,
  type SaveWorkflowTemplateDraftInput,
} from "../design-library/templates/workflow-template-save-service.ts";
import {
  listLibraryFiles,
  readLibraryFile,
  syncLibraryFileToGraph,
  writeLibraryFile,
} from "../design-library/files/library-file-store.ts";
import { listLibraryChatSessionSummariesPg, type LibraryChatAction } from "../read-models/library-chat.ts";
import { buildLibraryGraphReadModel } from "../read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../read-models/library-workspace.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

const DEFAULT_LIBRARY_READ_SCOPE = "all";
const DEFAULT_LIBRARY_AUTHORING_SCOPE = "general";

export async function handleLibraryRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/v2/library/workspace") {
    return json(
      "library-workspace",
      await buildLibraryWorkspaceReadModel(context.db, {
        selectedScope: url.searchParams.get("scope") ?? undefined,
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/graph") {
    return json(
      "library-graph",
      await buildLibraryGraphReadModel(context.db, {
        scope: graphScope(url),
        objectKey: url.searchParams.get("objectKey") ?? undefined,
        depth: optionalNumber(url.searchParams.get("depth")),
        kind: optionalLibraryKind(url.searchParams.get("kind")),
        status: optionalLibraryStatus(url.searchParams.get("status")),
        edgeType: optionalLibraryEdgeType(url.searchParams.get("edgeType")),
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/graph/neighborhood") {
    return json(
      "library-graph-neighborhood",
      await buildLibraryGraphReadModel(context.db, {
        scope: graphScope(url),
        objectKey: requiredQueryParam(url, "objectKey"),
        depth: optionalNumber(url.searchParams.get("depth")),
        kind: optionalLibraryKind(url.searchParams.get("kind")),
        status: optionalLibraryStatus(url.searchParams.get("status")),
        edgeType: optionalLibraryEdgeType(url.searchParams.get("edgeType")),
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/chat/sessions") {
    return json("library-chat-sessions", {
      sessions: await listLibraryChatSessionSummariesPg(context.db, {
        limit: optionalNumber(url.searchParams.get("limit")) ?? 50,
      }),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/files") {
    return json("library-files", { files: await listLibraryFiles({ root: libraryRoot(context) }) });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/import-drafts") {
    const body = await readJsonBody<{ source?: unknown; scope?: unknown; requestPrompt?: unknown }>(request);
    return json("library-import-draft", await createLibraryImportDraft(context.db, {
      source: asImportSource(body.source),
      scope: libraryAuthoringScope(body.scope),
      requestPrompt: optionalString(body.requestPrompt),
      sourceFetcher: context.libraryImportSourceFetcher,
      llmProvider: context.libraryImportLlmProvider,
    }));
  }

  const importDraftApproveMatch = url.pathname.match(/^\/api\/v2\/library\/import-drafts\/([^/]+)\/approve$/);
  if (request.method === "POST" && importDraftApproveMatch) {
    const body = await readJsonBody<{ actor?: unknown; reason?: unknown }>(request);
    return json("library-import-draft-approval", await approveLibraryImportDraft(context.db, {
      root: libraryRoot(context),
      draftId: decodeURIComponent(importDraftApproveMatch[1]!),
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
    }));
  }

  const importDraftInstallMatch = url.pathname.match(/^\/api\/v2\/library\/import-drafts\/([^/]+)\/install$/);
  if (request.method === "POST" && importDraftInstallMatch) {
    const body = await readJsonBody<{
      selectedCandidateIds?: unknown;
      selectedEdgeIds?: unknown;
      actor?: unknown;
      reason?: unknown;
    }>(request);
    return json("library-import-candidate-install", await installLibraryImportCandidates(context.db, {
      root: libraryRoot(context),
      draftId: decodeURIComponent(importDraftInstallMatch[1]!),
      selectedCandidateIds: stringArray(body.selectedCandidateIds, "selectedCandidateIds"),
      ...(Array.isArray(body.selectedEdgeIds)
        ? { selectedEdgeIds: stringArray(body.selectedEdgeIds, "selectedEdgeIds") }
        : {}),
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
      llmProvider: context.libraryImportLlmProvider,
    }));
  }

  const importDraftInstallStreamMatch = url.pathname.match(/^\/api\/v2\/library\/import-drafts\/([^/]+)\/install\/stream$/);
  if (request.method === "POST" && importDraftInstallStreamMatch) {
    const body = await readJsonBody<{
      selectedCandidateIds?: unknown;
      selectedEdgeIds?: unknown;
      actor?: unknown;
      reason?: unknown;
    }>(request);
    return libraryImportInstallEventStream(context, {
      draftId: decodeURIComponent(importDraftInstallStreamMatch[1]!),
      selectedCandidateIds: stringArray(body.selectedCandidateIds, "selectedCandidateIds"),
      ...(Array.isArray(body.selectedEdgeIds)
        ? { selectedEdgeIds: stringArray(body.selectedEdgeIds, "selectedEdgeIds") }
        : {}),
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
    });
  }

  const saveTemplateMatch = url.pathname.match(/^\/api\/v2\/workflow\/drafts\/([^/]+)\/save-template$/);
  if (request.method === "POST" && saveTemplateMatch) {
    const body = await readJsonBody<any>(request);
    const draftId = decodeURIComponent(saveTemplateMatch[1]!);
    const draft = await getResourceByKeyPg(context.db, "planner_draft", draftId);
    if (!draft) return errorJson(`planner draft not found: ${draftId}`, 404);
    const draftPayload = asRecord(draft.payload);
    const workflow = asRecord(draftPayload.workflow);
    const scope = requiredNonBlankString(body.scope, "scope");
    const status = workflowTemplateSaveStatus(body.status);
    const compositionPlan = workflowCompositionPlanFromDraftPayload(draftPayload);
    const result = await saveWorkflowTemplateDraft(context.db, {
      root: libraryRoot(context),
      scope,
      templateId: requiredString(body.templateId, "templateId"),
      title: requiredString(body.title, "title"),
      status,
      ...(compositionPlan ? { compositionPlan } : {}),
      ...await saveTemplateGraphFromWorkflow(context.db, workflow, scope),
    });
    return json("workflow-template-save", { draftId, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/import-prompts") {
    const body = await readJsonBody<{ prompt?: unknown; scope?: unknown }>(request);
    const prompt = requiredString(body.prompt, "prompt");
    const scope = libraryAuthoringScope(body.scope);
    const draft = await createLibraryImportDraft(context.db, {
      source: { kind: "paste", label: "Prompt import", content: prompt },
      scope,
      sourceFetcher: context.libraryImportSourceFetcher,
      llmProvider: context.libraryImportLlmProvider,
    });
    return json("library-import-prompt", {
      ...draft,
      files: draft.proposal.files.map((file) => ({ relativePath: file.relativePath })),
      objectKeys: draft.proposal.objectKeys,
      status: "ready_for_review",
    });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/profile-drafts/validate") {
    const body = await readJsonBody<{ profile?: unknown; draft?: unknown }>(request);
    const profile = requiredGeneratedProfileInput(isRecord(body.draft) && body.draft.profile ? body.draft.profile : body.profile);
    return json("library-profile-draft-validation", {
      profile,
      validation: await validateGeneratedNodeProfile(context.db, profile),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/profile-drafts/compose") {
    const body = await readJsonBody<{
      scope?: unknown;
      nodeId?: unknown;
      requirement?: unknown;
      preferredAgentRef?: unknown;
      templateId?: unknown;
    }>(request);
    return json("library-profile-draft", await composeNodeProfileDraft(context.db, {
      scope: libraryAuthoringScope(body.scope),
      nodeId: requiredNonBlankString(body.nodeId, "nodeId"),
      requirement: requiredNonBlankString(body.requirement, "requirement"),
      preferredAgentRef: requiredNonBlankString(body.preferredAgentRef, "preferredAgentRef"),
      templateId: optionalString(body.templateId),
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/profile-drafts/save") {
    const body = await readJsonBody<{
      draft?: unknown;
      templateId?: unknown;
      actor?: unknown;
      reason?: unknown;
    }>(request);
    return json("library-profile-draft-save", await saveNodeProfileDraft(context.db, {
      root: libraryRoot(context),
      draft: requiredNodeProfileDraft(body.draft),
      templateId: requiredNonBlankString(body.templateId, "templateId"),
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/chat/messages") {
    const body = await readJsonBody<{ sessionId?: unknown; prompt?: unknown; scope?: unknown }>(request);
    const prompt = requiredNonBlankString(body.prompt, "prompt");
    const action: LibraryChatAction = {
      actionId: `library-action-${randomUUID()}`,
      sessionId: optionalString(body.sessionId) ?? `library-chat-${randomUUID()}`,
      prompt,
      scope: libraryReadScope(body.scope),
    };

    await upsertRuntimeResourcePg(context.db, {
      resourceType: "library_chat_action",
      resourceKey: action.actionId,
      sessionId: action.sessionId,
      scope: "library",
      status: "active",
      title: `Library action: ${prompt.slice(0, 80)}`,
      payload: {
        schemaVersion: "southstar.library.chat_action.v1",
        actionId: action.actionId,
        sessionId: action.sessionId,
        actionSessionId: action.sessionId,
        prompt: action.prompt,
        selectedScope: action.scope,
      },
      summary: { prompt: action.prompt, selectedScope: action.scope },
    });

    return json("library-chat-message", {
      sessionId: action.sessionId,
      actionId: action.actionId,
      status: "accepted",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/chat/events") {
    const sessionId = requiredQueryParam(url, "sessionId");
    const actionId = requiredQueryParam(url, "actionId");
    const action = await requireLibraryChatAction(context, { sessionId, actionId });
    return libraryChatEventStream(context, { sessionId, actionId, prompt: action.prompt, scope: action.scope });
  }

  const lifecycleMatch = url.pathname.match(/^\/api\/v2\/library\/objects\/([^/]+)\/(approve|deprecate|block)$/);
  if (request.method === "POST" && lifecycleMatch) {
    const body = await readJsonBody<{ actor?: unknown; reason?: unknown }>(request);
    const action = lifecycleMatch[2] as LibraryObjectLifecycleAction;
    return json("library-object-lifecycle", await applyLibraryObjectLifecycleAction(context.db, {
      objectKey: decodeURIComponent(lifecycleMatch[1]!),
      action,
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
    }));
  }

  const objectValidateMatch = url.pathname.match(/^\/api\/v2\/library\/objects\/([^/]+)\/validate$/);
  if (request.method === "POST" && objectValidateMatch) {
    return json(
      "library-object-validation",
      await buildLibraryObjectDetail(context.db, decodeURIComponent(objectValidateMatch[1]!)),
    );
  }

  const objectMatch = url.pathname.match(/^\/api\/v2\/library\/objects\/([^/]+)$/);
  if (request.method === "GET" && objectMatch) {
    return json(
      "library-object-detail",
      await buildLibraryObjectDetail(context.db, decodeURIComponent(objectMatch[1]!)),
    );
  }
  if (request.method === "DELETE" && objectMatch) {
    const objectKey = decodeURIComponent(objectMatch[1]!);
    const result = await deleteLibraryObject(context.db, objectKey);
    if (!result) return errorJson(`library object not found: ${objectKey}`, 404);
    return json("library-object-delete", result);
  }

  const fileValidateMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)\/validate$/);
  if (request.method === "POST" && fileValidateMatch) {
    const relativePath = decodeURIComponent(fileValidateMatch[1]!);
    const file = await readLibraryFile({ root: libraryRoot(context), relativePath });
    const issues = file.parsed.issues;
    return json("library-file-validation", {
      relativePath,
      parsed: file.parsed,
      validation: {
        ok: file.parsed.ok && !issues.some((issue) => issue.severity === "error"),
        issues,
      },
    });
  }

  const syncMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)\/sync$/);
  if (request.method === "POST" && syncMatch) {
    return json(
      "library-file-sync",
      await syncLibraryFileToGraph(context.db, {
        root: libraryRoot(context),
        relativePath: decodeURIComponent(syncMatch[1]!),
      }),
    );
  }

  const fileMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)$/);
  if (fileMatch) {
    const relativePath = decodeURIComponent(fileMatch[1]!);
    if (request.method === "GET") {
      return json("library-file", await readLibraryFile({ root: libraryRoot(context), relativePath }));
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody<{ content?: unknown }>(request);
      await writeLibraryFile({
        root: libraryRoot(context),
        relativePath,
        content: requiredString(body.content, "content"),
      });
      return json("library-file", await readLibraryFile({ root: libraryRoot(context), relativePath }));
    }
  }

  return undefined;
}

function libraryRoot(context: RuntimeServerContext): string {
  return context.libraryRoot ?? process.env.SOUTHSTAR_LIBRARY_ROOT ?? "library";
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}

function requiredNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function libraryReadScope(value: unknown): string {
  return optionalString(value) ?? DEFAULT_LIBRARY_READ_SCOPE;
}

function libraryAuthoringScope(value: unknown): string {
  const scope = optionalString(value);
  return !scope || scope === DEFAULT_LIBRARY_READ_SCOPE ? DEFAULT_LIBRARY_AUTHORING_SCOPE : scope;
}

function workflowTemplateSaveStatus(_value: unknown): "draft" {
  return "draft";
}

function requiredQueryParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`number query param is invalid: ${value}`);
  return parsed;
}

function graphScope(url: URL): string | undefined {
  return url.searchParams.get("scope") ?? url.searchParams.get("domain") ?? undefined;
}

const LIBRARY_DEFINITION_KINDS = new Set<LibraryDefinitionKind>([
  "agent_spec",
  "agent_definition",
  "agent_profile",
  "skill_definition",
  "domain_taxonomy",
  "mcp_tool_grant",
  "artifact_contract",
  "evaluator_profile",
  "capability_spec",
  "contract_spec",
  "validator_spec",
  "policy_bundle",
  "workflow_template",
  "workflow_recipe",
  "tool_definition",
  "instruction_template",
  "vault_lease_policy",
  "skill_spec",
]);

const LIBRARY_DEFINITION_STATUSES = new Set<LibraryDefinitionStatus>([
  "draft",
  "approved",
  "deprecated",
  "blocked",
]);

const LIBRARY_EDGE_TYPES = new Set<LibraryEdgeType>([
  "implements",
  "provides_capability",
  "requires_capability",
  "uses",
  "requires_skill",
  "allows_tool",
  "requires_tool",
  "uses_instruction",
  "requires_secret_group",
  "allows_mcp_grant",
  "produces_artifact",
  "consumes_artifact",
  "validates_artifact",
  "uses_policy",
  "part_of_template",
  "supersedes",
  "blocked_by",
  "belongs_to_domain",
  "has_capability",
  "provides",
  "uses",
  "requires",
  "conflicts_with",
  "precedes",
  "workflow_precedes",
  "unblocks",
  "validates",
  "reviews",
  "produces",
  "consumes",
  "similar_to",
  "substitutes",
  "complements",
  "incompatible_with",
  "requires_approval",
  "requires_secret",
]);

function optionalLibraryKind(value: string | null): LibraryDefinitionKind | undefined {
  if (!value || value === "all") return undefined;
  if (!LIBRARY_DEFINITION_KINDS.has(value as LibraryDefinitionKind)) throw new Error(`invalid library kind: ${value}`);
  return value as LibraryDefinitionKind;
}

function optionalLibraryStatus(value: string | null): LibraryDefinitionStatus | undefined {
  if (!value || value === "all") return undefined;
  if (!LIBRARY_DEFINITION_STATUSES.has(value as LibraryDefinitionStatus)) throw new Error(`invalid library status: ${value}`);
  return value as LibraryDefinitionStatus;
}

function optionalLibraryEdgeType(value: string | null): LibraryEdgeType | undefined {
  if (!value || value === "all") return undefined;
  if (!LIBRARY_EDGE_TYPES.has(value as LibraryEdgeType)) throw new Error(`invalid library edge type: ${value}`);
  return value as LibraryEdgeType;
}

function graphQueryFromPrompt(
  prompt: string,
  defaultScope: string,
): Parameters<typeof buildLibraryGraphReadModel>[1] {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const query: Parameters<typeof buildLibraryGraphReadModel>[1] = { scope: defaultScope };

  const explicitScope = matchTokenAfter(lower, ["scope", "domain", "domain:", "scope:"]);
  if (explicitScope) query.scope = explicitScope;
  else if (/\ball\b/.test(lower)) query.scope = "all";
  else {
    const namedScope = text.match(/\b([a-z][a-z0-9_-]*)\s+(?:domain|scope)\b/i)?.[1];
    if (namedScope) query.scope = namedScope;
  }

  const objectKey = text.match(/\b(?:agent|skill|tool|mcp|profile|artifact|capability|instruction|policy|workflow)\.[A-Za-z0-9._-]+\b/)?.[0];
  if (objectKey) query.objectKey = objectKey;

  const depth = lower.match(/\bdepth[:=\s]+(\d+)\b/)?.[1] ?? lower.match(/\b(\d+)\s*(?:層|层|hop|hops)\b/)?.[1];
  if (depth) query.depth = Number(depth);

  const kind = kindFromPrompt(lower);
  if (kind) query.kind = kind;

  const status = statusFromPrompt(lower);
  if (status) query.status = status;

  const edgeType = edgeTypeFromPrompt(lower);
  if (edgeType) query.edgeType = edgeType;

  return query;
}

function matchTokenAfter(text: string, prefixes: string[]): string | undefined {
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = text.match(new RegExp(`\\b${escaped}\\s*([a-z][a-z0-9_-]*)\\b`))?.[1];
    if (value) return value;
  }
  return undefined;
}

function kindFromPrompt(text: string): LibraryDefinitionKind | undefined {
  if (/\bagents?\b|agent_definition|代理|智能体/.test(text)) return "agent_definition";
  if (/skill_definition/.test(text)) return "skill_definition";
  if (/\bskills?\b|skill_spec|技能/.test(text)) return "skill_spec";
  if (/\btools?\b|tool_definition|工具/.test(text)) return "tool_definition";
  if (/\bmcp\b|mcp_tool_grant/.test(text)) return "mcp_tool_grant";
  if (/\bprofiles?\b|agent_profile/.test(text)) return "agent_profile";
  if (/\btemplates?\b|workflow_template/.test(text)) return "workflow_template";
  return undefined;
}

function statusFromPrompt(text: string): LibraryDefinitionStatus | undefined {
  if (/\bdraft\b|草稿/.test(text)) return "draft";
  if (/\bapproved\b|已核准|已批准/.test(text)) return "approved";
  if (/\bdeprecated\b|廢棄|废弃/.test(text)) return "deprecated";
  if (/\bblocked\b|封鎖|封锁/.test(text)) return "blocked";
  return undefined;
}

function edgeTypeFromPrompt(text: string): LibraryEdgeType | undefined {
  const exact = text.match(/\b(?:edgeType|edge|relation|relationship)[:=\s]+([a-z_]+)\b/i)?.[1];
  if (exact && LIBRARY_EDGE_TYPES.has(exact as LibraryEdgeType)) return exact as LibraryEdgeType;
  if (/\bworkflow_precedes\b|先後|先后|順序|顺序/.test(text)) return "workflow_precedes";
  if (/\bprecedes\b/.test(text)) return "precedes";
  if (/\bunblocks\b|解鎖|解锁/.test(text)) return "unblocks";
  if (/\bvalidates\b|驗證|验证/.test(text)) return "validates";
  if (/\breviews\b|review|審查|审查/.test(text)) return "reviews";
  if (/\bproduces\b|產出|产出/.test(text)) return "produces";
  if (/\bconsumes\b|消耗|需要輸入|需要输入/.test(text)) return "consumes";
  if (/\bsubstitutes\b|替代/.test(text)) return "substitutes";
  if (/\bcomplements\b|互補|互补/.test(text)) return "complements";
  if (/\bincompatible_with\b|不相容/.test(text)) return "incompatible_with";
  if (/\brequires_approval\b|人工批准|人工核准/.test(text)) return "requires_approval";
  if (/\brequires_secret\b|secret|credential|憑證|凭证/.test(text)) return "requires_secret";
  if (/\bhas_capability\b|能力/.test(text)) return "has_capability";
  if (/\bprovides\b|提供/.test(text)) return "provides";
  if (/\bsimilar_to\b|相似/.test(text)) return "similar_to";
  if (/\bconflicts_with\b|衝突|冲突/.test(text)) return "conflicts_with";
  if (/\brequires\b|依賴|依赖|required/.test(text)) return "requires";
  if (/\buses\b|使用/.test(text)) return "uses";
  return undefined;
}

function asGraphQuery(value: unknown): Parameters<typeof buildLibraryGraphReadModel>[1] {
  if (!isRecord(value)) return {};
  return {
    scope: optionalString(value.scope),
    objectKey: optionalString(value.objectKey),
    depth: typeof value.depth === "number" ? value.depth : undefined,
    kind: LIBRARY_DEFINITION_KINDS.has(value.kind as LibraryDefinitionKind) ? value.kind as LibraryDefinitionKind : undefined,
    status: LIBRARY_DEFINITION_STATUSES.has(value.status as LibraryDefinitionStatus) ? value.status as LibraryDefinitionStatus : undefined,
    edgeType: LIBRARY_EDGE_TYPES.has(value.edgeType as LibraryEdgeType) ? value.edgeType as LibraryEdgeType : undefined,
  };
}

function requiredNodeProfileDraft(value: unknown): NodeProfileDraft {
  if (!isRecord(value)) throw new Error("draft is required");
  const profile = isRecord(value.profile) ? value.profile : null;
  const validation = isRecord(value.validation) ? value.validation : null;
  if (!profile || !validation) throw new Error("draft is required");
  return value as NodeProfileDraft;
}

function requiredGeneratedProfileInput(value: unknown): Parameters<typeof validateGeneratedNodeProfile>[1] {
  if (!isRecord(value)) throw new Error("profile is required");
  return {
    scope: requiredNonBlankString(value.scope, "profile.scope"),
    nodeId: requiredNonBlankString(value.nodeId, "profile.nodeId"),
    agentRef: requiredNonBlankString(value.agentRef, "profile.agentRef"),
    skillRefs: stringArray(value.skillRefs, "profile.skillRefs"),
    toolGrantRefs: stringArray(value.toolGrantRefs, "profile.toolGrantRefs"),
    mcpGrantRefs: stringArray(value.mcpGrantRefs, "profile.mcpGrantRefs"),
    instructionRefs: stringArray(value.instructionRefs, "profile.instructionRefs"),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  const invalid = value.find((item) => typeof item !== "string" || item.length === 0);
  if (invalid !== undefined) throw new Error(`${field} must contain strings`);
  return value as string[];
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function errorJson(error: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

async function saveTemplateGraphFromWorkflow(
  db: SouthstarDb,
  workflow: Record<string, unknown>,
  scope: string,
): Promise<Pick<SaveWorkflowTemplateDraftInput, "nodes" | "edges" | "libraryVersionRefs">> {
  const tasks = Array.isArray(workflow.tasks)
    ? workflow.tasks.filter((task): task is Record<string, unknown> => isRecord(task))
    : [];
  const nodeIdByRawId = new Map(tasks.map((task) => {
    const rawId = requiredString(task.id, "workflow.tasks.id");
    return [rawId, pathSafeWorkflowNodeId(rawId)];
  }));
  const nodeIds = new Set(nodeIdByRawId.values());
  const nodes = await Promise.all(tasks.map(async (task) => {
    const rawId = requiredString(task.id, "workflow.tasks.id");
    const id = nodeIdByRawId.get(rawId) ?? pathSafeWorkflowNodeId(rawId);
    return {
      id,
      title: optionalString(task.name) ?? id,
      agentRef: await agentRefForWorkflowTask(db, task, scope),
      skillRefs: libraryRefs(task.skillRefs, "skill."),
      toolGrantRefs: libraryRefs(task.toolGrantRefs, "tool."),
      mcpGrantRefs: libraryRefs(task.mcpGrantRefs, "mcp."),
    };
  }));
  return {
    nodes,
    edges: tasks.flatMap((task) => {
      const rawTo = requiredString(task.id, "workflow.tasks.id");
      const to = nodeIdByRawId.get(rawTo) ?? pathSafeWorkflowNodeId(rawTo);
      return libraryRefs(task.dependsOn, "")
        .map((from) => nodeIdByRawId.get(from) ?? pathSafeWorkflowNodeId(from))
        .filter((from) => nodeIds.has(from))
        .map((from) => ({ from, to }));
    }),
    libraryVersionRefs: await libraryVersionRefsForNodes(db, nodes),
  };
}

function pathSafeWorkflowNodeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^task[._-]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";
}

async function buildLibraryObjectDetail(db: SouthstarDb, objectKey: string) {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object) throw new Error(`library object not found: ${objectKey}`);
  const [inboundEdges, outboundEdges] = await Promise.all([
    findLibraryEdgesTo(db, objectKey),
    findLibraryEdgesFrom(db, objectKey),
  ]);
  return {
    object,
    inboundEdges,
    outboundEdges,
    usage: {
      inboundCount: inboundEdges.length,
      outboundCount: outboundEdges.length,
      usedByObjectKeys: inboundEdges.map((edge) => edge.fromObjectKey),
      dependsOnObjectKeys: outboundEdges.map((edge) => edge.toObjectKey),
    },
    validation: {
      ok: object.status === "approved",
      issues: object.status === "approved" ? [] : [{
        code: "object_not_approved",
        path: "status",
        message: `${objectKey} is ${object.status}`,
      }],
    },
  };
}

async function libraryVersionRefsForNodes(
  db: SouthstarDb,
  nodes: SaveWorkflowTemplateDraftInput["nodes"],
): Promise<string[]> {
  const objectKeys = new Set<string>();
  for (const node of nodes) {
    objectKeys.add(node.agentRef);
    for (const ref of node.skillRefs) objectKeys.add(ref);
    for (const ref of node.toolGrantRefs) objectKeys.add(ref);
    for (const ref of node.mcpGrantRefs) objectKeys.add(ref);
  }

  const versionRefs: string[] = [];
  for (const objectKey of objectKeys) {
    const object = await findLibraryObjectByKey(db, objectKey);
    if (!object) throw new Error(`library ref does not resolve to a graph object: ${objectKey}`);
    if (!object.headVersionId) throw new Error(`library ref does not have a head version: ${objectKey}`);
    versionRefs.push(object.headVersionId);
  }
  return versionRefs;
}

async function agentRefForWorkflowTask(db: SouthstarDb, task: Record<string, unknown>, scope: string): Promise<string> {
  const explicit = optionalString(task.agentDefinitionRef);
  if (explicit?.startsWith("agent.")) {
    await requireAgentDefinition(db, explicit);
    return explicit;
  }

  const profileRef = profileObjectKey(optionalString(task.agentProfileRef));
  if (profileRef) {
    const edges = await findLibraryEdgesFrom(db, profileRef, "implements", { scope });
    const agentRefs = [...new Set(edges
      .map((edge) => edge.toObjectKey)
      .filter((toObjectKey) => toObjectKey.startsWith("agent.")))];
    if (agentRefs.length === 1) {
      await requireAgentDefinition(db, agentRefs[0]!);
      return agentRefs[0]!;
    }
    if (agentRefs.length > 1) {
      throw new Error(`ambiguous agentRef for workflow task ${requiredString(task.id, "workflow.tasks.id")}: ${agentRefs.join(", ")}`);
    }
  }

  const roleRef = optionalString(task.roleRef);
  if (roleRef) {
    const agentRef = roleRef.startsWith("agent.") ? roleRef : `agent.${roleRef}`;
    await requireAgentDefinition(db, agentRef);
    return agentRef;
  }

  throw new Error(
    `cannot derive graph-backed agentRef for workflow task ${requiredString(task.id, "workflow.tasks.id")}; persisted workflow must include agentDefinitionRef or a library-backed agentProfileRef`,
  );
}

function libraryRefs(value: unknown, prefix: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (
    typeof item === "string" && item.length > 0 && (prefix.length === 0 || item.startsWith(prefix))
  ));
}

function profileObjectKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.startsWith("profile.") ? trimmed : `profile.${trimmed}`;
}

function workflowCompositionPlanFromDraftPayload(payload: Record<string, unknown>): WorkflowCompositionPlan | undefined {
  const plan = asRecord(asRecord(payload.orchestrationSnapshot).selectedCompositionPlan);
  if (plan.schemaVersion !== "southstar.workflow_composition_plan.v1") return undefined;
  if (!Array.isArray(plan.tasks)) return undefined;
  return plan as unknown as WorkflowCompositionPlan;
}

async function requireAgentDefinition(db: SouthstarDb, objectKey: string): Promise<void> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (object?.objectKind !== "agent_definition") {
    throw new Error(`agentRef does not resolve to a graph-backed agent definition: ${objectKey}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireLibraryChatAction(
  context: RuntimeServerContext,
  input: { sessionId: string; actionId: string },
): Promise<LibraryChatAction> {
  const action = await getResourceByKeyPg(context.db, "library_chat_action", input.actionId);
  if (!action) throw new Error(`library chat action ${input.actionId} was not found`);
  const payload = asRecord(action.payload);
  const actionSessionId = optionalString(payload.actionSessionId) ?? optionalString(payload.sessionId);
  if (action.sessionId !== input.sessionId && actionSessionId !== input.sessionId) {
    throw new Error(`library chat action ${input.actionId} does not belong to session ${input.sessionId}`);
  }
  return {
    actionId: input.actionId,
    sessionId: actionSessionId ?? input.sessionId,
    prompt: requiredNonBlankString(payload.prompt, "library_chat_action.prompt"),
    scope: libraryReadScope(payload.selectedScope),
  };
}

function libraryChatEventStream(
  context: RuntimeServerContext,
  input: { sessionId: string; actionId: string; prompt: string; scope: string },
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, { sessionId: input.sessionId, actionId: input.actionId, ...data })));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      heartbeat = startLibrarySseHeartbeat(context, emit, { phase: "library_chat" });
      try {
        if (await replayCompletedLibraryChatAction(context, input, emit)) return;
        await updateLibraryChatAction(context, input, "running", {
          startedAt: new Date().toISOString(),
        });
        emit("library.intent.started", { message: "Reading library command." });
        if (isImportDraftPrompt(input.prompt)) {
          emit("library.intent.completed", { intent: "import_library_candidates", confidence: 0.95 });
          const draft = await createLibraryImportDraft(context.db, {
            source: importSourceFromPrompt(input.prompt) ?? { kind: "paste", label: "Library chat prompt", content: input.prompt },
            scope: libraryAuthoringScope(input.scope),
            requestPrompt: input.prompt,
            sourceFetcher: context.libraryImportSourceFetcher,
            llmProvider: context.libraryImportLlmProvider,
            progress: ({ event, data }) => emit(event, data),
          });
          const candidateCount = draft.candidates?.length ?? 0;
          if (candidateCount > 0) {
            emit("library.import.candidates", {
              draftId: draft.draftId,
              status: draft.status,
              title: "Import candidates",
              candidates: draft.candidates ?? [],
              proposedEdges: [],
            });
          } else {
            emit("library.proposal.created", {
              draftId: draft.draftId,
              status: draft.status,
              title: "Draft library proposal",
              objectKeys: draft.proposal.objectKeys,
              objectSummaries: draft.proposal.objectSummaries,
              dependencies: draft.proposal.dependencies,
              filePaths: draft.proposal.files.map((file) => file.relativePath),
            });
          }
          const result = {
            draftId: draft.draftId,
            status: "ready_for_review",
            candidateCount,
            ...(draft.piSessionId ? { piSessionId: draft.piSessionId } : {}),
          };
          await updateLibraryChatAction(context, input, "completed", {
            completedAt: new Date().toISOString(),
            ...result,
          });
          emit("library.command.completed", result);
          return;
        }
        emit("library.intent.completed", { intent: "library_graph", confidence: 0.7 });
        const graphQuery = graphQueryFromPrompt(input.prompt, input.scope);
        const graph = await buildLibraryGraphReadModel(context.db, graphQuery);
        emit("library.graph.snapshot", graph as unknown as Record<string, unknown>);
        emit("library.validation.completed", { ok: true, issues: [] });
        await updateLibraryChatAction(context, input, "completed", {
          completedAt: new Date().toISOString(),
          intent: "library_graph",
          graphQuery,
          status: "completed",
        });
        emit("library.command.completed", { status: "completed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updateLibraryChatAction(context, input, "failed", {
          failedAt: new Date().toISOString(),
          error: message,
        }).catch(() => undefined);
        emit("library.error", { message });
      } finally {
        const wasClosed = closed;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // The browser may have cancelled the stream already.
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    },
  }), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function libraryImportInstallEventStream(
  context: RuntimeServerContext,
  input: {
    draftId: string;
    selectedCandidateIds: string[];
    selectedEdgeIds?: string[];
    actor: string;
    reason: string;
  },
): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      heartbeat = startLibrarySseHeartbeat(context, emit, {
        phase: "library_import_install",
        draftId: input.draftId,
      });
      try {
        emit("library.import.install.requested", {
          draftId: input.draftId,
          selectedCandidateCount: input.selectedCandidateIds.length,
        });
        const installed = await installLibraryImportCandidates(context.db, {
          root: libraryRoot(context),
          draftId: input.draftId,
          selectedCandidateIds: input.selectedCandidateIds,
          ...(input.selectedEdgeIds ? { selectedEdgeIds: input.selectedEdgeIds } : {}),
          actor: input.actor,
          reason: input.reason,
          llmProvider: context.libraryImportLlmProvider,
          progress: ({ event, data }) => emit(event, data),
        });
        emit("library.db.synced", {
          draftId: input.draftId,
          objectKeys: installed.graph.objectKeys,
          edgeIds: installed.graph.edgeIds,
        });
        emit("library.graph.snapshot", await installedImportGraphSnapshot(context, installed));
        emit("library.command.completed", { draftId: input.draftId, status: "installed" });
      } catch (error) {
        emit("library.error", {
          draftId: input.draftId,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        const wasClosed = closed;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // The browser may have cancelled the stream already.
          }
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    },
  }), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

async function installedImportGraphSnapshot(
  context: RuntimeServerContext,
  installed: Awaited<ReturnType<typeof installLibraryImportCandidates>>,
): Promise<Record<string, unknown>> {
  const graph = await buildLibraryGraphReadModel(context.db, { scope: "all" });
  const installedObjectKeys = new Set(installed.graph.objectKeys);
  const installedEdgeIds = new Set(installed.graph.edgeIds);
  const edges = graph.edges.filter((edge) => installedEdgeIds.has(edge.id));
  const visibleObjectKeys = new Set(installedObjectKeys);
  for (const edge of edges) {
    visibleObjectKeys.add(edge.fromObjectKey);
    visibleObjectKeys.add(edge.toObjectKey);
  }
  const activeScope = installed.installedObjects
    .map(({ object }) => optionalString(object.state.scope))
    .find((scope): scope is string => Boolean(scope)) ?? "all";
  return {
    ...graph,
    activeScope,
    query: {
      ...(activeScope !== "all" ? { scope: activeScope } : {}),
      installedObjectKeys: installed.graph.objectKeys,
      installedEdgeIds: installed.graph.edgeIds,
    },
    nodes: graph.nodes.filter((node) => visibleObjectKeys.has(node.objectKey)),
    edges,
  };
}

function isImportDraftPrompt(prompt: string): boolean {
  return /\b(create|import)\b/i.test(prompt)
    || /(?:\u532f\u5165|\u5bfc\u5165|\u5b58\u5165|\u65b0\u589e|\u5b89\u88dd|\u5b89\u88c5)/.test(prompt);
}

function importSourceFromPrompt(prompt: string): Parameters<typeof createLibraryImportDraft>[1]["source"] | null {
  const match = prompt.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#][^\s\])>]*)?/i);
  if (!match) return null;
  return { kind: "github", repoUrl: `https://github.com/${match[1]}/${match[2]}` };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startLibrarySseHeartbeat(
  context: RuntimeServerContext,
  emit: (event: string, data: Record<string, unknown>) => void,
  data: Record<string, unknown>,
): ReturnType<typeof setInterval> {
  const intervalMs = Math.max(1, context.libraryChatHeartbeatMs ?? 15_000);
  return setInterval(() => {
    emit("library.progress.keepalive", {
      ...data,
      at: new Date().toISOString(),
    });
  }, intervalMs);
}

async function replayCompletedLibraryChatAction(
  context: RuntimeServerContext,
  input: { sessionId: string; actionId: string; scope: string },
  emit: (event: string, data: Record<string, unknown>) => void,
): Promise<boolean> {
  const action = await getResourceByKeyPg(context.db, "library_chat_action", input.actionId);
  const actionPayload = asRecord(action?.payload);
  const result = asRecord(actionPayload.result);
  const draftId = optionalString(result.draftId);
  if (action?.status !== "completed") return false;
  if (!draftId && optionalString(result.intent) === "library_graph") {
    const graphQuery = asGraphQuery(result.graphQuery);
    emit("library.intent.completed", { intent: "cached_library_graph", confidence: 1 });
    emit("library.graph.snapshot", await buildLibraryGraphReadModel(context.db, {
      ...graphQuery,
      scope: graphQuery.scope ?? input.scope,
    }) as unknown as Record<string, unknown>);
    emit("library.command.completed", { status: optionalString(result.status) ?? "completed", cached: true });
    return true;
  }
  if (!draftId) return false;

  const draft = await getResourceByKeyPg(context.db, "library_import_draft", draftId);
  const draftPayload = asRecord(draft?.payload);
  const candidates = Array.isArray(draftPayload.candidates) ? draftPayload.candidates : [];
  emit("library.intent.completed", { intent: "cached_library_import", confidence: 1 });
  if (candidates.length > 0) {
    emit("library.import.candidates", {
      draftId,
      status: optionalString(draftPayload.status) ?? draft?.status ?? "draft",
      title: "Import candidates",
      candidates,
      proposedEdges: Array.isArray(draftPayload.proposedEdges) ? draftPayload.proposedEdges : [],
    });
  } else {
    const proposal = asRecord(draftPayload.proposal);
    emit("library.proposal.created", {
      draftId,
      status: optionalString(draftPayload.status) ?? draft?.status ?? "draft",
      title: "Draft library proposal",
      objectKeys: Array.isArray(proposal.objectKeys) ? proposal.objectKeys : [],
      objectSummaries: Array.isArray(proposal.objectSummaries) ? proposal.objectSummaries : [],
      dependencies: Array.isArray(proposal.dependencies) ? proposal.dependencies : [],
      filePaths: Array.isArray(proposal.files)
        ? proposal.files.map((file) => isRecord(file) ? file.relativePath : undefined).filter(Boolean)
        : [],
    });
  }
  emit("library.command.completed", {
    draftId,
    status: optionalString(result.status) ?? "ready_for_review",
    candidateCount: typeof result.candidateCount === "number" ? result.candidateCount : candidates.length,
    ...(optionalString(result.piSessionId) ? { piSessionId: optionalString(result.piSessionId) } : {}),
    cached: true,
  });
  return true;
}

async function updateLibraryChatAction(
  context: RuntimeServerContext,
  input: { sessionId: string; actionId: string },
  status: string,
  result: Record<string, unknown>,
): Promise<void> {
  const existing = await getResourceByKeyPg(context.db, "library_chat_action", input.actionId);
  const payload = asRecord(existing?.payload);
  const summary = asRecord(existing?.summary);
  const nextResult = {
    ...asRecord(payload.result),
    ...result,
  };
  const actionSessionId = optionalString(payload.actionSessionId) ?? optionalString(payload.sessionId) ?? input.sessionId;
  const piSessionId = optionalString(nextResult.piSessionId);
  await upsertRuntimeResourcePg(context.db, {
    resourceType: "library_chat_action",
    resourceKey: input.actionId,
    sessionId: piSessionId ?? existing?.sessionId ?? input.sessionId,
    scope: "library",
    status,
    title: existing?.title ?? `Library action: ${optionalString(payload.prompt) ?? input.actionId}`,
    payload: {
      ...payload,
      actionSessionId,
      result: nextResult,
    },
    summary: {
      ...summary,
      status,
      ...(piSessionId ? { piSessionId } : {}),
      result: nextResult,
    },
  });
}
