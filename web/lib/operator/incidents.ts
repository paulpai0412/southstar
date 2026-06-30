import type { OperatorAttentionItem, OperatorIncident, OperatorOverview, OperatorPriorityLanes, OperatorRun } from "./types";

const severityOrder = new Map([
  ["blocked", 4],
  ["error", 3],
  ["warning", 2],
  ["info", 1],
]);

export function buildOperatorIncidents(overview: OperatorOverview): OperatorIncident[] {
  const runs = new Map(overview.runs.map((run) => [run.runId, run]));
  const groups = new Map<string, OperatorAttentionItem[]>();

  for (const item of overview.attentionItems) {
    const key = [
      item.runId || "global",
      item.taskId || "run",
      item.reason || item.title || item.kind || "attention",
    ].join("::");
    groups.set(key, [...(groups.get(key) || []), item]);
  }

  return [...groups.entries()].map(([key, items]) => {
    const first = items[0]!;
    const run = first.runId ? runs.get(first.runId) : undefined;
    const severity = highestSeverity(items);
    const commands = items.flatMap((item) => item.commands || []);
    const commandIds = unique(commands.map((command) => command.id));
    const evidenceRefs = unique(items.flatMap(readEvidenceRefs));
    const firstCommand = commands[0];
    const status: OperatorIncident["status"] = severity === "blocked" || severity === "error" ? "needs_action" : "observing";
    return {
      id: `incident:${key}`,
      runId: first.runId || "",
      taskId: first.taskId || null,
      severity,
      status,
      title: first.title || `${severity} incident`,
      cause: first.reason || first.kind || first.title || "unknown",
      impact: run ? `${run.title} cannot progress normally while this incident is active.` : "Runtime attention requires review.",
      nextAction: firstCommand ? `Review and run ${firstCommand.label}` : "Open history and review recovery evidence",
      ageLabel: formatAge(first.updatedAt || run?.updatedAt),
      firstSeenAt: oldestDate(items.map((item) => item.updatedAt)),
      lastSeenAt: newestDate(items.map((item) => item.updatedAt)),
      evidenceRefs,
      commandIds,
      sourceAttentionIds: items.map((item) => item.id),
    };
  }).sort(compareIncidents);
}

export function buildOperatorPriorityLanes(runs: OperatorRun[], incidents: OperatorIncident[]): OperatorPriorityLanes {
  const incidentRunIds = new Set(incidents.map((incident) => incident.runId));
  return {
    needsAction: incidents.filter((incident) => incident.status === "needs_action"),
    atRisk: incidents.filter((incident) => incident.status === "observing"),
    running: runs.filter((run) => !incidentRunIds.has(run.runId)),
    recentlyResolved: incidents.filter((incident) => incident.status === "resolved"),
  };
}

function highestSeverity(items: OperatorAttentionItem[]): OperatorIncident["severity"] {
  return items.reduce<OperatorIncident["severity"]>((highest, item) => {
    const severity = normalizeSeverity(item.severity);
    return (severityOrder.get(severity) || 0) > (severityOrder.get(highest) || 0) ? severity : highest;
  }, "info");
}

function normalizeSeverity(severity: string): OperatorIncident["severity"] {
  if (severity === "blocked" || severity === "error" || severity === "warning" || severity === "info") return severity;
  return "info";
}

function readEvidenceRefs(item: OperatorAttentionItem): string[] {
  const refs = item.detail?.evidenceRefs;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareIncidents(a: OperatorIncident, b: OperatorIncident): number {
  return (severityOrder.get(b.severity) || 0) - (severityOrder.get(a.severity) || 0);
}

function formatAge(value: string | undefined): string {
  if (!value) return "age unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "age unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function oldestDate(values: Array<string | undefined>): string | null {
  const dates = values.map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  return dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
}

function newestDate(values: Array<string | undefined>): string | null {
  const dates = values.map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  return dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;
}
