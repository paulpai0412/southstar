type Panel = { id: string; title: string };

export type PiWebOperationsDashboardRenderable = {
  surface: "pi-web.operations-dashboard.v1";
  selectedRunId: string | null;
  selectedTaskId: string | null;
  panels: Panel[];
  plannerChat: { drafts: unknown[] };
  workflowCanvas: { status: string; nodes: Array<{ id: string; label: string; status: string; dependsOn: string[] }> };
  runtimeMonitor: {
    status: string;
    latestProgress?: string;
    latestSteering?: string;
    executorJobIds: string[];
    runningTaskIds: string[];
  };
  taskDetail: unknown;
  agentDefinitions: { harnesses: unknown[]; taskAgents: unknown[] };
  sessionsMemory: { sessions: unknown[]; memoryItems: unknown[] };
  vaultMcp: { vaultLeases: unknown[]; mcpGrants: unknown[] };
  executorOps: { bindings: unknown[] };
};

export function renderPiWebOperationsDashboardHtml(model: PiWebOperationsDashboardRenderable): string {
  return [
    '<section class="southstar-ops" data-surface="pi-web.operations-dashboard.v1">',
    renderHeader(model),
    '<main class="southstar-ops-grid">',
    renderPanel("planner-chat", "Planner Chat", renderPlannerChat(model)),
    renderPanel("workflow-canvas", "Workflow Canvas", renderWorkflowCanvas(model)),
    renderPanel("runtime-monitor", "Runtime Monitor", renderRuntimeMonitor(model)),
    renderPanel("task-detail", "Task Detail", renderJson(model.taskDetail)),
    renderPanel("agent-definitions", "Agent Definitions", renderAgentDefinitions(model)),
    renderPanel("sessions-memory", "Sessions/Memory", renderSessionsMemory(model)),
    renderPanel("vault-mcp", "Vault/MCP", renderVaultMcp(model)),
    renderPanel("executor-ops", "Executor Ops", renderExecutorOps(model)),
    "</main>",
    "</section>",
    renderStyles(),
  ].join("");
}

function renderHeader(model: PiWebOperationsDashboardRenderable): string {
  return [
    '<header class="southstar-ops-header">',
    "<div>",
    '<div class="southstar-eyebrow">Southstar v2</div>',
    "<h1>Operations Dashboard</h1>",
    "</div>",
    `<div class="southstar-run-pill">${escapeHtml(model.selectedRunId ?? "no run selected")}</div>`,
    "</header>",
  ].join("");
}

function renderPanel(id: string, title: string, body: string): string {
  return `<article class="southstar-panel" data-panel="${escapeHtml(id)}"><h2>${escapeHtml(title)}</h2>${body}</article>`;
}

function renderPlannerChat(model: PiWebOperationsDashboardRenderable): string {
  return model.plannerChat.drafts.length
    ? `<ul>${model.plannerChat.drafts.map((draft) => `<li>${escapeHtml(summaryLine(draft))}</li>`).join("")}</ul>`
    : '<p class="southstar-muted">No planner drafts</p>';
}

function renderWorkflowCanvas(model: PiWebOperationsDashboardRenderable): string {
  const nodes = model.workflowCanvas.nodes.map((node) => [
    `<li class="southstar-node southstar-node-${escapeHtml(node.status)}">`,
    `<span>${escapeHtml(node.label)}</span>`,
    `<code>${escapeHtml(node.id)}</code>`,
    node.dependsOn.length ? `<small>depends on ${escapeHtml(node.dependsOn.join(", "))}</small>` : "",
    "</li>",
  ].join(""));
  return `<ol class="southstar-canvas">${nodes.join("")}</ol>`;
}

function renderRuntimeMonitor(model: PiWebOperationsDashboardRenderable): string {
  return [
    `<p>Status: <strong>${escapeHtml(model.runtimeMonitor.status)}</strong></p>`,
    `<p>Progress: ${escapeHtml(model.runtimeMonitor.latestProgress ?? "none")}</p>`,
    `<p>Steering: ${escapeHtml(model.runtimeMonitor.latestSteering ?? "none")}</p>`,
    `<p>Running tasks: ${escapeHtml(model.runtimeMonitor.runningTaskIds.join(", ") || "none")}</p>`,
    `<p>Executor jobs: ${escapeHtml(model.runtimeMonitor.executorJobIds.join(", ") || "none")}</p>`,
  ].join("");
}

function renderAgentDefinitions(model: PiWebOperationsDashboardRenderable): string {
  return [
    `<p>Harnesses: ${model.agentDefinitions.harnesses.length}</p>`,
    `<p>Task agents: ${model.agentDefinitions.taskAgents.length}</p>`,
    renderJson(model.agentDefinitions),
  ].join("");
}

function renderSessionsMemory(model: PiWebOperationsDashboardRenderable): string {
  return [
    `<p>Sessions: ${model.sessionsMemory.sessions.length}</p>`,
    `<p>Memory items: ${model.sessionsMemory.memoryItems.length}</p>`,
    renderJson(model.sessionsMemory.memoryItems),
  ].join("");
}

function renderVaultMcp(model: PiWebOperationsDashboardRenderable): string {
  return [
    `<p>Vault leases: ${model.vaultMcp.vaultLeases.length}</p>`,
    `<p>MCP grants: ${model.vaultMcp.mcpGrants.length}</p>`,
  ].join("");
}

function renderExecutorOps(model: PiWebOperationsDashboardRenderable): string {
  return model.executorOps.bindings.length
    ? `<ul>${model.executorOps.bindings.map((binding) => `<li>${escapeHtml(summaryLine(binding))}</li>`).join("")}</ul>`
    : '<p class="southstar-muted">No executor bindings</p>';
}

function renderJson(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function summaryLine(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return String(value);
  const record = value as Record<string, unknown>;
  return [record.title, record.id, record.status, record.workflowId, record.torkJobId]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join(" · ") || JSON.stringify(value);
}

function renderStyles(): string {
  return `<style>
.southstar-ops{min-height:100dvh;background:var(--bg,#fff);color:var(--text,#1a1a1a);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:16px}
.southstar-ops-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.southstar-eyebrow{font-size:12px;color:var(--text-muted,#6b7280);text-transform:uppercase}
.southstar-ops h1{font-size:22px;line-height:1.15;margin:0}
.southstar-run-pill{border:1px solid var(--border,#e0e0e0);border-radius:6px;padding:6px 10px;font-family:var(--font-mono,monospace);font-size:12px;background:var(--bg-panel,#f5f5f5)}
.southstar-ops-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.southstar-panel{border:1px solid var(--border,#e0e0e0);border-radius:8px;background:var(--bg-panel,#f5f5f5);padding:12px;min-height:170px;overflow:auto}
.southstar-panel h2{font-size:14px;margin:0 0 10px}
.southstar-panel p,.southstar-panel li{font-size:12px;line-height:1.45}
.southstar-panel pre{font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0}
.southstar-canvas{display:grid;gap:8px;list-style:none;padding:0;margin:0}
.southstar-node{border:1px solid var(--border,#e0e0e0);border-radius:6px;padding:8px;background:var(--bg,#fff);display:grid;gap:4px}
.southstar-node code,.southstar-node small{color:var(--text-muted,#6b7280);font-size:11px}
.southstar-muted{color:var(--text-muted,#6b7280)}
@media(max-width:1100px){.southstar-ops-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){.southstar-ops-grid{grid-template-columns:1fr}.southstar-ops-header{align-items:flex-start;flex-direction:column}}
</style>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
