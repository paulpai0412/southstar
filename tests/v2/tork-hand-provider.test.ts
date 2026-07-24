import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTorkHandProvider } from "../../src/v2/hands/tork-hand-provider.ts";
import type { ExecutorProvider, ExecutorSubmitRequest } from "../../src/v2/executor/provider.ts";
import type { ExecuteTaskInput, HandBinding } from "../../src/v2/hands/types.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";

test("TorkHandProvider.executeTask submits a single-task workflow with hand execution metadata", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-tork-hand-provider-"));
  const submitted: ExecutorSubmitRequest[] = [];
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    async submit(request) {
      submitted.push(request);
      return {
        executorType: "tork",
        externalJobId: "job-1",
        status: "queued",
        projectionFingerprint: "fingerprint-1",
        providerPayload: { jobName: "southstar-run-hand-task-a" },
      };
    },
  };
  const provider = createTorkHandProvider({
    executorProvider,
    callbackUrl: "http://127.0.0.1/default-callback",
    heartbeatUrl: "http://127.0.0.1/default-heartbeat",
    runRoot,
  });
  const binding = handBinding({ taskId: "task-b" });
  const input = executeTaskInput({
    taskId: "task-b",
    callbackUrl: "http://127.0.0.1/task-callback",
    heartbeatUrl: "http://127.0.0.1/task-heartbeat",
    envelopeBasePath: "/task-envelopes",
  });

  try {
    assert.equal(typeof provider.executeTask, "function");
    const result = await provider.executeTask!(binding, input);

    assert.equal(result.ok, true);
    assert.equal(result.output, "job-1");
    assert.deepEqual(result.metadata, {
      handExecutionId: "hand-exec-1",
      executorType: "tork",
      externalJobId: "job-1",
      projectionFingerprint: "fingerprint-1",
    });
    assert.equal(binding.status, "running");
    assert.equal(binding.payload.handExecutionId, "hand-exec-1");
    assert.equal(binding.payload.executorType, "tork");
    assert.equal(binding.payload.executorStatus, "queued");
    assert.equal(binding.payload.externalJobId, "job-1");
    assert.equal(binding.payload.projectionFingerprint, "fingerprint-1");
    assert.deepEqual(binding.payload.providerPayload, { jobName: "southstar-run-hand-task-a" });
    assert.equal(binding.payload.queueTimeoutSeconds, 45);
    assert.equal(binding.payload.heartbeatTimeoutSeconds, 180);

    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]!.runId, "run-hand");
    assert.equal(submitted[0]!.callbackUrl, "http://127.0.0.1/task-callback");
    assert.equal(submitted[0]!.heartbeatUrl, "http://127.0.0.1/task-heartbeat");
    assert.equal(submitted[0]!.envelopeBasePath, "/task-envelopes");
    assert.equal(submitted[0]!.attemptId, "attempt-1");
    assert.equal(submitted[0]!.workflow.tasks.length, 1);
    assert.equal(submitted[0]!.workflow.tasks[0]!.id, "task-b");
    assert.deepEqual(submitted[0]!.workflow.tasks[0]!.dependsOn, []);
    assert.equal(
      submitted[0]!.workflow.tasks[0]!.execution.mounts.some((mount) => mount.source === runRoot && mount.target === "/task-envelopes"),
      true,
    );
    assert.equal(submitted[0]!.workflow.harnessDefinitions.length, 1);
    assert.equal(submitted[0]!.workflow.evaluators.length, 1);
    assert.deepEqual((submitted[0]!.workflow as SouthstarWorkflowManifest & { runtime: Record<string, unknown> }).runtime, {
      runId: "run-hand",
      taskId: "task-b",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-exec-1",
      brainBindingId: "brain-binding-1",
      handBindingId: "hand-binding-1",
      contextPacketRef: "context-a",
      acceptedInputArtifactRefs: ["artifact-a"],
      toolProxyPolicyRef: "policy-a",
      queueTimeoutSeconds: 45,
      heartbeatTimeoutSeconds: 180,
      intent: input.intent,
    });
    const materializedEnvelope = JSON.parse(await readFile(join(runRoot, "run-hand", "task-b", "envelope.json"), "utf8"));
    assert.equal(materializedEnvelope.schemaVersion, "southstar.task-envelope.v2");
    assert.equal(materializedEnvelope.runId, "run-hand");
    assert.equal(materializedEnvelope.taskId, "task-b");
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("TorkHandProvider.executeTask mounts Pi OAuth config for pi-agent tasks", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-tork-hand-provider-"));
  const piAgentDir = await mkdtemp(join(tmpdir(), "southstar-pi-agent-dir-"));
  const previousPiAgentDir = process.env.SOUTHSTAR_PI_AGENT_DIR;
  const submitted: ExecutorSubmitRequest[] = [];
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    async submit(request) {
      submitted.push(request);
      return {
        executorType: "tork",
        externalJobId: "job-pi",
        status: "queued",
        projectionFingerprint: "fingerprint-pi",
        providerPayload: { jobName: "southstar-run-hand-pi" },
      };
    },
  };
  const provider = createTorkHandProvider({
    executorProvider,
    callbackUrl: "http://127.0.0.1/default-callback",
    runRoot,
  });

  try {
    process.env.SOUTHSTAR_PI_AGENT_DIR = piAgentDir;
    const result = await provider.executeTask!(
      handBinding({ taskId: "task-a" }),
      executeTaskInput({ workflow: workflowManifest({ harnessKind: "pi-agent" }) }),
    );

    assert.equal(result.ok, true);
    assert.equal(submitted.length, 1);
    const execution = submitted[0]!.workflow.tasks[0]!.execution;
    assert.equal(execution.env.PI_CODING_AGENT_DIR, "/southstar/pi-agent");
    assert.equal(execution.env.PI_CODING_AGENT_SESSION_DIR, "/tmp/pi-agent-sessions");
    assert.deepEqual(
      execution.mounts.find((mount) => mount.target === "/southstar/pi-agent"),
      { source: piAgentDir, target: "/southstar/pi-agent", readonly: true },
    );
  } finally {
    if (previousPiAgentDir === undefined) {
      delete process.env.SOUTHSTAR_PI_AGENT_DIR;
    } else {
      process.env.SOUTHSTAR_PI_AGENT_DIR = previousPiAgentDir;
    }
    await rm(runRoot, { recursive: true, force: true });
    await rm(piAgentDir, { recursive: true, force: true });
  }
});

test("TorkHandProvider.executeTask mounts host workspace at the container repo path", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-tork-hand-provider-"));
  const submitted: ExecutorSubmitRequest[] = [];
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    async submit(request) {
      submitted.push(request);
      return {
        executorType: "tork",
        externalJobId: "job-workspace",
        status: "queued",
        projectionFingerprint: "fingerprint-workspace",
        providerPayload: { jobName: "southstar-run-hand-workspace" },
      };
    },
  };
  const provider = createTorkHandProvider({
    executorProvider,
    callbackUrl: "http://127.0.0.1/default-callback",
    runRoot,
  });

  try {
    const result = await provider.executeTask!(
      handBinding({ taskId: "task-a" }),
      executeTaskInput({
        taskEnvelope: {
          ...taskEnvelope("task-a"),
          workspace: {
            handle: {
              repoRoot: "/workspace/repo",
              worktreePath: "/workspace/repo",
              hostMountPath: "/home/timmypai/apps/customer-todo-web",
            },
          },
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      submitted[0]!.workflow.tasks[0]!.execution.mounts.find((mount) => mount.target === "/workspace/repo"),
      { source: "/home/timmypai/apps/customer-todo-web", target: "/workspace/repo", readonly: false },
    );
    const materializedEnvelope = JSON.parse(await readFile(join(runRoot, "run-hand", "task-a", "envelope.json"), "utf8"));
    assert.deepEqual(materializedEnvelope.workspace.handle, {
      repoRoot: "/workspace/repo",
      worktreePath: "/workspace/repo",
      hostMountPath: "/home/timmypai/apps/customer-todo-web",
    });
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("TorkHandProvider.executeTask rejects the Southstar project as a host workspace mount", async () => {
  let submitted = false;
  const provider = createTorkHandProvider({
    callbackUrl: "http://127.0.0.1/default-callback",
    executorProvider: {
      executorType: "tork",
      submit: async () => {
        submitted = true;
        throw new Error("submit should not be called");
      },
    },
  });
  const binding = handBinding({ taskId: "task-a" });

  const result = await provider.executeTask!(
    binding,
    executeTaskInput({
      taskEnvelope: {
        ...taskEnvelope("task-a"),
        workspace: {
          handle: {
            repoRoot: "/workspace/repo",
            worktreePath: "/workspace/repo",
            hostMountPath: process.cwd(),
          },
        },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.output, /refusing to mount Southstar project as workspace repo/);
  assert.equal(binding.status, "failed");
  assert.match(String(binding.payload.lastError), /refusing to mount Southstar project as workspace repo/);
  assert.equal(submitted, false);
});

test("TorkHandProvider.executeTask fails missing workflow input and marks binding failed", async () => {
  let submitted = false;
  const provider = createTorkHandProvider({
    callbackUrl: "http://127.0.0.1/default-callback",
    executorProvider: {
      executorType: "tork",
      submit: async () => {
        submitted = true;
        throw new Error("submit should not be called");
      },
    },
  });
  const binding = handBinding();
  const input = executeTaskInput({ workflow: undefined });

  assert.equal(typeof provider.executeTask, "function");
  const result = await provider.executeTask!(binding, input);

  assert.equal(result.ok, false);
  assert.equal(result.output, "missing workflow input for Tork task execution");
  assert.equal(binding.status, "failed");
  assert.equal(binding.payload.lastError, "missing workflow input for Tork task execution");
  assert.equal(submitted, false);
  assert.deepEqual(result.metadata, { handExecutionId: "hand-exec-1" });
});

test("TorkHandProvider.executeTask fails when task is absent from workflow and marks binding failed", async () => {
  let submitted = false;
  const provider = createTorkHandProvider({
    callbackUrl: "http://127.0.0.1/default-callback",
    executorProvider: {
      executorType: "tork",
      submit: async () => {
        submitted = true;
        throw new Error("submit should not be called");
      },
    },
  });
  const binding = handBinding();
  const input = executeTaskInput({ taskId: "missing-task" });

  assert.equal(typeof provider.executeTask, "function");
  const result = await provider.executeTask!(binding, input);

  assert.equal(result.ok, false);
  assert.equal(result.output, "task not found in workflow: missing-task");
  assert.equal(binding.status, "failed");
  assert.equal(binding.payload.lastError, "task not found in workflow: missing-task");
  assert.equal(submitted, false);
  assert.deepEqual(result.metadata, { handExecutionId: "hand-exec-1" });
});

test("TorkHandProvider.executeTask converts submit failures into failed hand results", async () => {
  const provider = createTorkHandProvider({
    callbackUrl: "http://127.0.0.1/default-callback",
    executorProvider: {
      executorType: "tork",
      submit: async () => {
        throw new Error("tork submit failed");
      },
    },
  });
  const binding = handBinding();

  assert.equal(typeof provider.executeTask, "function");
  const result = await provider.executeTask!(binding, executeTaskInput());

  assert.equal(result.ok, false);
  assert.equal(result.output, "Tork task execution failed: tork submit failed");
  assert.equal(binding.status, "failed");
  assert.equal(binding.payload.lastError, "tork submit failed");
  assert.deepEqual(result.metadata, { handExecutionId: "hand-exec-1", error: "tork submit failed" });
});

function handBinding(overrides: Partial<HandBinding> = {}): HandBinding {
  return {
    id: "hand-binding-1",
    providerId: "tork",
    runId: "run-hand",
    taskId: "task-a",
    handName: "workspace",
    status: "provisioned",
    createdAt: "2026-06-21T00:00:00.000Z",
    payload: { resourceKeys: ["workspace"] },
    ...overrides,
  };
}

function executeTaskInput(overrides: Partial<ExecuteTaskInput> = {}): ExecuteTaskInput {
  const taskId = overrides.taskId ?? "task-a";
  const input: ExecuteTaskInput = {
    runId: "run-hand",
    taskId,
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-exec-1",
    brainBindingId: "brain-binding-1",
    handBindingId: "hand-binding-1",
    contextPacketRef: "context-a",
    acceptedInputArtifactRefs: ["artifact-a"],
    toolProxyPolicyRef: "policy-a",
    workflow: workflowManifest(),
    taskEnvelope: taskEnvelope(taskId),
    queueTimeoutSeconds: 45,
    heartbeatTimeoutSeconds: 180,
    intent: {
      schemaVersion: "southstar.brain.task_execution_intent.v1",
      runId: "run-hand",
      taskId,
      sessionId: "session-a",
      contextPacketId: "context-a",
      attemptId: "attempt-1",
      expectedArtifactContracts: ["implementation-report"],
      allowedToolNames: ["shell.exec"],
      toolProxyPolicyRef: "policy-a",
      handProviderId: "tork",
      executionMode: "single_task",
      instructionsRef: "context-a",
      inputArtifactRefs: ["artifact-a"],
    },
  };
  return { ...input, ...overrides };
}

function taskEnvelope(taskId: string): unknown {
  return {
    schemaVersion: "southstar.task-envelope.v2",
    runId: "run-hand",
    workflowId: "wf-tork-hand-provider",
    taskId,
    domain: "software",
    intent: "implement_feature",
    role: { id: "maker", responsibility: "Implement the task." },
    agentProfile: {
      id: "profile.maker",
      roleRef: "maker",
      provider: "pi",
      model: "pi-agent-default",
      harnessRef: "pi",
      promptTemplateRef: "instruction.maker",
      agentsMdRefs: [],
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopes: [],
      contextPolicyRef: "context-a",
      sessionPolicyRef: "session-a",
      toolPolicy: { allowedTools: [] },
      budgetPolicy: { maxWallTimeSeconds: 900 },
    },
    harness: {
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: [],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket: {
      id: "context-a",
      runId: "run-hand",
      taskId,
      executionAttempt: 1,
      roleRef: "maker",
      agentProfileRef: "profile.maker",
      taskGoal: "Implement the task.",
      roleInstruction: "Implement the task.",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      priorArtifacts: [],
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
      tokenEstimate: { total: 0, bySourceType: {} },
      excludedCandidates: [],
    },
    agentPrompt: "Implement the task.",
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: [],
    evaluatorPipeline: { id: "evaluator", evaluators: [], onFailure: { defaultStrategy: "retry-same-agent" } },
    session: { sessionId: "session-a", maxRepairAttempts: 1 },
  };
}

function workflowManifest(options: { harnessKind?: "codex" | "pi-agent" } = {}): SouthstarWorkflowManifest {
  const harnessKind = options.harnessKind ?? "codex";
  const harnessId = harnessKind === "pi-agent" ? "pi" : "codex";
  const image = harnessKind === "pi-agent" ? "southstar/pi-agent:local" : "southstar/codex-agent:local";
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-tork-hand-provider",
    title: "Tork hand provider workflow",
    goalPrompt: "submit one task from the hand provider",
    tasks: [
      {
        id: "task-a",
        name: "Task A",
        domain: "software",
        dependsOn: [],
        execution: taskExecution(image),
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
        subagents: [{ id: "impl", harnessId, prompt: "implement task A", requiredArtifacts: ["implementation-report"] }],
      },
      {
        id: "task-b",
        name: "Task B",
        domain: "software",
        dependsOn: ["task-a"],
        execution: taskExecution(image),
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
        subagents: [{ id: "impl", harnessId, prompt: "implement task B", requiredArtifacts: ["implementation-report"] }],
      },
    ],
    harnessDefinitions: [
      {
        id: harnessId,
        kind: harnessKind,
        entrypoint: "southstar-agent-runner",
        image,
        capabilities: ["software"],
        inputProtocol: harnessKind === "pi-agent" ? "task-envelope-v2" : "task-envelope-v1",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      },
    ],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

function taskExecution(image = "southstar/codex-agent:local") {
  return {
    engine: "tork" as const,
    image,
    command: ["southstar-agent-runner"],
    env: {},
    mounts: [],
    timeoutSeconds: 900,
    infraRetry: { maxAttempts: 1 },
  };
}
