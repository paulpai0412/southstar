import { createHash } from "node:crypto";
import { validatePlanBundle } from "../manifests/validate.ts";
import type {
  HarnessDefinition,
  HarnessKind,
  PlanBundle,
  SouthstarWorkflowManifest,
  WorkflowTaskDefinition,
} from "../manifests/types.ts";
import type { PiPlannerClient, PiPlannerStreamHandlers, PlannerContext } from "./types.ts";

export type { PiPlannerClient, PiPlannerStreamHandlers, PlannerContext };

export async function generatePlanBundle(
  client: PiPlannerClient,
  context: PlannerContext,
): Promise<PlanBundle> {
  return (await generatePlanBundleWithTimings(client, context)).bundle;
}

export async function generatePlanBundleWithTimings(
  client: PiPlannerClient,
  context: PlannerContext,
): Promise<{ bundle: PlanBundle; plannerMs: number; validationMs: number }> {
  let prompt = buildPlannerPrompt(context);
  let plannerMs = 0;
  let validationMs = 0;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const plannerStartedAt = Date.now();
    const raw = await client.generate(prompt);
    plannerMs += Date.now() - plannerStartedAt;
    const validationStartedAt = Date.now();
    try {
      const parsed = parsePlanBundleJson(raw, context.goalPrompt);
      const validation = validatePlanBundle(parsed);
      validationMs += Date.now() - validationStartedAt;
      if (validation.ok) return { bundle: parsed, plannerMs, validationMs };
      lastError = new Error(`Pi planner returned invalid PlanBundle: ${JSON.stringify(validation.issues)}`);
    } catch (error) {
      validationMs += Date.now() - validationStartedAt;
      lastError = error as Error;
    }
    prompt = buildPlannerRepairPrompt(context, raw, lastError.message);
  }
  throw lastError ?? new Error("Pi planner failed to generate a PlanBundle");
}

export async function runPlannerRevisionLoop(
  client: PiPlannerClient,
  context: PlannerContext,
  maxRevisions: number,
): Promise<PlanBundle> {
  let nextContext = context;
  let lastIssues: Array<{ path: string; message: string }> = [];
  for (let attempt = 0; attempt <= maxRevisions; attempt++) {
    const raw = await client.generate(buildPlannerPrompt(nextContext));
    const parsed = parsePlanBundleJson(raw, nextContext.goalPrompt);
    const validation = validatePlanBundle(parsed);
    if (validation.ok) return parsed;
    lastIssues = validation.issues;
    nextContext = { ...context, validationIssues: validation.issues };
  }
  throw new Error(`planner failed validation after ${maxRevisions} revisions: ${JSON.stringify(lastIssues)}`);
}

export function buildPlannerPrompt(context: PlannerContext): string {
  const validationSection = context.validationIssues?.length
    ? `\nPrevious validation issues:\n${context.validationIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`
    : "";
  return [
    "Return exactly one compact JSON object. No markdown, comments, arrays at top-level, or candidate alternatives.",
    "Use this shape: {\"goalPrompt\":\"...\",\"workflows\":[{\"id\":\"...\",\"name\":\"...\",\"tasks\":[...]}]}.",
    "Create exactly four tasks with ids: planner, implementer, root-validator, summary.",
    "Dependencies must be: planner [], implementer [planner], root-validator [implementer], summary [root-validator].",
    "Each task must include id, name, dependsOn, harnessId, and execution.command.",
    "Set implementer harnessId to pi. Other tasks may use codex.",
    "Set implementer skillRefs to [\"software.calc-cli\"].",
    "execution.command should be a short instruction string for the subagent, not shell code.",
    "The implementer instruction must mention editing /workspace/repo, calc sum <numbers...>, tests, README, and artifact fields summary/commandsRun/testResults/risks.",
    `Schema version: ${context.schemaVersion}.`,
    `Goal prompt: ${context.goalPrompt}`,
    `Available harness ids: ${context.availableHarnesses.join(", ")}`,
    "Use one canonical SouthstarWorkflowManifest. Do not emit a second Tork workflow.",
    "The Southstar runtime will canonicalize policies, Tork execution, root sessions, evaluators, memory, vault, MCP, and learning settings.",
    validationSection,
  ].join("\n");
}

function buildPlannerRepairPrompt(context: PlannerContext, previousRaw: string, error: string): string {
  return [
    buildPlannerPrompt(context),
    "",
    "Your previous response could not be accepted.",
    `Validation error: ${error}`,
    "Return a complete JSON object only. Do not use ellipses, placeholders, markdown, comments, or abbreviated arrays.",
    "Previous response:",
    previousRaw.slice(0, 12_000),
  ].join("\n");
}

export function createHttpPiPlannerClient(options: { endpoint: string; model?: string }): PiPlannerClient {
  return {
    async generate(prompt: string): Promise<string> {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, model: options.model }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Pi planner request failed: ${response.status} ${text}`);
      }
      const payload = JSON.parse(text) as { text?: string; output?: string; planBundle?: unknown };
      if (typeof payload.text === "string") return payload.text;
      if (typeof payload.output === "string") return payload.output;
      if (payload.planBundle) return JSON.stringify(payload.planBundle);
      throw new Error("Pi planner response missing text, output, or planBundle");
    },
  };
}

export type PiSdkPlannerSession = {
  prompt(text: string): Promise<void>;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  on?: (listener: (event: unknown) => void) => () => void;
};

export type PiSdkPlannerClientOptions = {
  createSession?: () => Promise<PiSdkPlannerSession>;
  timeoutMs?: number;
};

export function createPiSdkPlannerClient(options: PiSdkPlannerClientOptions = {}): PiPlannerClient {
  return {
    async generate(prompt: string): Promise<string> {
      const session = await (options.createSession ?? createDefaultPiSdkSession)();
      return runPromptAndCollectAssistantText(session, prompt, options.timeoutMs ?? 180_000);
    },
    async generateStream(prompt: string, handlers: PiPlannerStreamHandlers = {}): Promise<string> {
      const session = await (options.createSession ?? createDefaultPiSdkSession)();
      return runPromptAndCollectAssistantText(session, prompt, options.timeoutMs ?? 180_000, handlers);
    },
  };
}

export function plannerPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function parsePlanBundleJson(raw: string, sourceGoalPrompt?: string): PlanBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (error) {
    throw new Error(`Pi planner must return a valid JSON object: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.workflow) || !isRecord(parsed.plannerTrace)) {
    const canonical = canonicalizeCompactPiPlan(parsed, sourceGoalPrompt);
    if (canonical) return canonical;
    throw new Error("Pi planner must return a valid JSON object with workflow and plannerTrace");
  }
  return canonicalizePlanBundle(parsed as PlanBundle);
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function canonicalizeCompactPiPlan(parsed: unknown, sourceGoalPrompt?: string): PlanBundle | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.workflows) || !isRecord(parsed.workflows[0])) return undefined;
  const compact = parsed.workflows[0];
  if (!Array.isArray(compact.tasks)) return undefined;
  const goalPrompt = sourceGoalPrompt ?? (typeof parsed.goalPrompt === "string" ? parsed.goalPrompt : "");
  const tasks = compact.tasks
    .filter(isRecord)
    .map((task, index) => canonicalizeCompactTask(task, index, goalPrompt));
  const harnessDefinitions = buildHarnessDefinitions(tasks);
  const workflow: SouthstarWorkflowManifest = {
    schemaVersion: "southstar.v2",
    workflowId: stringValue(compact.id) ?? "southstar-pi-workflow",
    title: stringValue(compact.name) ?? stringValue(compact.id) ?? "Southstar Pi Workflow",
    goalPrompt,
    tasks,
    harnessDefinitions,
    evaluators: [{
      id: "schema-evaluator-v1",
      kind: "schema",
      artifactTypes: ["implementation-report"],
      requiredFields: ["summary", "commandsRun", "testResults", "risks"],
    }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
  return {
    workflow,
    plannerTrace: {
      model: "pi-agent",
      promptHash: plannerPromptHash(JSON.stringify(parsed)),
      generatedAt: new Date().toISOString(),
    },
  };
}

function canonicalizePlanBundle(bundle: PlanBundle): PlanBundle {
  return {
    ...bundle,
    workflow: canonicalizeWorkflowLike(bundle.workflow),
  };
}

function canonicalizeWorkflowLike(workflow: SouthstarWorkflowManifest): SouthstarWorkflowManifest {
  if (!Array.isArray(workflow.tasks)) return workflow;
  const tasks = workflow.tasks
    .filter(isRecord)
    .map((task, index) => canonicalizeWorkflowTaskLike(task, index));
  return {
    schemaVersion: "southstar.v2",
    workflowId: stringValue(workflow.workflowId) ?? "southstar-pi-workflow",
    title: stringValue(workflow.title) ?? stringValue(workflow.workflowId) ?? "Southstar Pi Workflow",
    goalPrompt: stringValue(workflow.goalPrompt) ?? "",
    tasks,
    harnessDefinitions: buildHarnessDefinitions(tasks),
    evaluators: [{
      id: "schema-evaluator-v1",
      kind: "schema",
      artifactTypes: ["implementation-report"],
      requiredFields: ["summary", "commandsRun", "testResults", "risks"],
    }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: Array.isArray(workflow.mcpServers) ? workflow.mcpServers : [],
    mcpGrants: Array.isArray(workflow.mcpGrants) ? workflow.mcpGrants : [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

function canonicalizeCompactTask(task: Record<string, unknown>, index: number, goalPrompt: string): WorkflowTaskDefinition {
  const execution = isRecord(task.execution) ? task.execution : {};
  const taskId = stringValue(task.id) ?? `task-${index + 1}`;
  const harnessId = stringValue(task.harnessId) ?? "pi";
  const instruction = instructionFromCompactCommand(execution.command) ?? stringValue(task.name) ?? taskId;
  const fixtureRepoMount = fixtureRepoMountFromGoal(goalPrompt);
  return {
    id: taskId,
    name: stringValue(task.name) ?? taskId,
    domain: "software",
    dependsOn: stringArray(task.dependsOn),
    execution: {
      engine: "tork",
      image: normalizeExecutionImage(stringValue(execution.image)),
      command: ["southstar-agent-runner"],
      env: recordOfStrings(execution.env),
      mounts: fixtureRepoMount ? [fixtureRepoMount] : [],
      timeoutSeconds: numberValue(execution.timeoutSeconds) ?? 900,
      infraRetry: { maxAttempts: 1 },
    },
    rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    skillRefs: skillRefsForTask(task.skillRefs, taskId),
    subagents: [{
      id: `${taskId}-subagent`,
      harnessId,
      prompt: instruction,
      requiredArtifacts: ["implementation-report"],
    }],
  };
}

function fixtureRepoMountFromGoal(goalPrompt: string): { source: string; target: string; readonly: boolean } | undefined {
  const match = goalPrompt.match(/Fixture repo:\s*([^\s。]+)/i);
  if (!match?.[1]) return undefined;
  return { source: match[1], target: "/workspace/repo", readonly: false };
}

function canonicalizeWorkflowTaskLike(task: Record<string, unknown>, index: number): WorkflowTaskDefinition {
  const execution = isRecord(task.execution) ? task.execution : {};
  const taskId = stringValue(task.id) ?? `task-${index + 1}`;
  const subagents = Array.isArray(task.subagents)
    ? task.subagents.filter(isRecord).map((subagent, subagentIndex) => ({
      id: stringValue(subagent.id) ?? `${taskId}-subagent-${subagentIndex + 1}`,
      harnessId: stringValue(subagent.harnessId) ?? "pi",
      prompt: stringValue(subagent.prompt) ?? instructionFromCompactCommand(execution.command) ?? stringValue(task.name) ?? taskId,
      requiredArtifacts: stringArray(subagent.requiredArtifacts).length
        ? stringArray(subagent.requiredArtifacts)
        : ["implementation-report"],
    }))
    : [];
  return {
    id: taskId,
    name: stringValue(task.name) ?? taskId,
    domain: domainValue(task.domain),
    dependsOn: stringArray(task.dependsOn),
    execution: {
      engine: "tork",
      image: normalizeExecutionImage(stringValue(execution.image)),
      command: commandArray(execution.command),
      env: recordOfStrings(execution.env),
      mounts: mountArray(execution.mounts),
      timeoutSeconds: numberValue(execution.timeoutSeconds) ?? 900,
      infraRetry: { maxAttempts: maxAttempts(execution.infraRetry) },
    },
    rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: repairAttempts(task.rootSession) },
    skillRefs: skillRefsForTask(task.skillRefs, taskId),
    subagents: subagents.length ? subagents : [{
      id: `${taskId}-subagent`,
      harnessId: stringValue(task.harnessId) ?? "pi",
      prompt: instructionFromCompactCommand(execution.command) ?? stringValue(task.name) ?? taskId,
      requiredArtifacts: ["implementation-report"],
    }],
  };
}

function buildHarnessDefinitions(tasks: WorkflowTaskDefinition[]): HarnessDefinition[] {
  const ids = [...new Set(tasks.flatMap((task) => task.subagents.map((subagent) => subagent.harnessId)))]
    .filter(isKnownHarnessId);
  return ids.map((id) => ({
    id,
    kind: harnessKind(id),
    entrypoint: "southstar-agent-runner",
    image: "southstar/pi-agent:local",
    capabilities: ["software"],
    inputProtocol: "task-envelope-v1",
    eventProtocol: "southstar-events-v1",
    supportsCheckpoint: true,
    supportsSteering: true,
    supportsProgress: true,
  }));
}

function isKnownHarnessId(id: string): boolean {
  return id === "pi" || id === "codex" || id === "claude-code" || id === "custom";
}

function harnessKind(id: string): HarnessKind {
  if (id === "pi") return "pi-agent";
  if (id === "codex") return "codex";
  if (id === "claude-code") return "claude-code";
  return "custom";
}

function instructionFromCompactCommand(value: unknown): string | undefined {
  const command = typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : undefined;
  if (!command) return undefined;
  const quoted = command.match(/--instruction\s+"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  const unquoted = command.match(/--instruction\s+(.+?)(?:\s+--|$)/);
  return unquoted?.[1]?.trim() || command;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function commandArray(value: unknown): string[] {
  const command = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : typeof value === "string"
      ? value.split(/\s+/).filter(Boolean)
      : [];
  return command[0] === "southstar-agent-runner" ? command : ["southstar-agent-runner"];
}

function normalizeExecutionImage(image: string | undefined): string {
  void image;
  return "southstar/pi-agent:local";
}

function mountArray(value: unknown): Array<{ source: string; target: string; readonly: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((mount) => {
    const source = stringValue(mount.source);
    const target = stringValue(mount.target);
    if (!source || !target) return [];
    return [{
      source,
      target,
      readonly: typeof mount.readonly === "boolean"
        ? mount.readonly
        : typeof mount.readOnly === "boolean"
          ? mount.readOnly
          : false,
    }];
  });
}

function maxAttempts(value: unknown): number {
  if (!isRecord(value)) return 1;
  return numberValue(value.maxAttempts) ?? 1;
}

function repairAttempts(value: unknown): number {
  if (!isRecord(value)) return 2;
  return numberValue(value.maxRepairAttempts) ?? 2;
}

function skillRefsForTask(value: unknown, taskId: string): string[] {
  const refs = stringArray(value);
  if (/implement/i.test(taskId)) refs.push("software.calc-cli");
  return [...new Set(refs)];
}

function domainValue(value: unknown): WorkflowTaskDefinition["domain"] {
  return value === "software" || value === "research" || value === "data-analysis" || value === "general"
    ? value
    : "software";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createDefaultPiSdkSession(): Promise<PiSdkPlannerSession> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const result = await pi.createAgentSession({
    noTools: "all",
    sessionStartEvent: {
      mode: "sdk",
      source: "southstar-pi-planner",
      cwd: process.cwd(),
    } as never,
  });
  return result.session as unknown as PiSdkPlannerSession;
}

async function runPromptAndCollectAssistantText(
  session: PiSdkPlannerSession,
  prompt: string,
  timeoutMs: number,
  handlers: PiPlannerStreamHandlers = {},
): Promise<string> {
  let finalText = "";
  let lastStreamedText = "";
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<string>((resolve, reject) => {
    const listener = (event: unknown) => {
      const text = assistantTextFromEvent(event);
      if (text) {
        finalText = text;
        const delta = text.startsWith(lastStreamedText)
          ? text.slice(lastStreamedText.length)
          : text;
        if (delta) handlers.onDelta?.(delta);
        lastStreamedText = text;
      }
      if (isRecord(event) && event.type === "agent_end") {
        resolve(finalText);
      }
    };
    unsubscribe = session.subscribe?.(listener) ?? session.on?.(listener);
    if (!unsubscribe) {
      reject(new Error("Pi SDK AgentSession must expose subscribe(listener)"));
    }
  });
  const promptAndDone = (async () => {
    await session.prompt(prompt);
    return done;
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Pi SDK planner timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const text = await Promise.race([promptAndDone, timeout]);
    if (!text.trim()) throw new Error("Pi SDK planner returned empty assistant text");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    promptAndDone.catch(() => undefined);
    unsubscribe?.();
  }
}

function assistantTextFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (Array.isArray(event.messages)) {
    const assistant = [...event.messages].reverse().find((message) =>
      isRecord(message) && message.role === "assistant"
    );
    return textFromMessage(assistant);
  }
  const message = event.message;
  if (isRecord(message) && "role" in message && message.role !== "assistant") return undefined;
  return textFromMessage(message);
}

function textFromMessage(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("")
    .trim() || undefined;
}
