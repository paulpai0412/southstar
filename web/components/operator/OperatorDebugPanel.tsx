"use client";

import { useMemo, useState } from "react";
import type { OperatorHistoryItem, OperatorResourceItem, OperatorTaskDebug } from "@/lib/operator/types";

type DebugTab = "Overview" | "Session" | "Context" | "Envelope" | "Memory" | "Artifacts" | "Resources" | "Raw";

type DebugRow = {
  id: string;
  label: string;
  meta?: string;
  body: unknown;
};

const tabs: DebugTab[] = ["Overview", "Session", "Context", "Envelope", "Memory", "Artifacts", "Resources", "Raw"];

export function OperatorDebugPanel({ debug }: { debug: OperatorTaskDebug }) {
  const [activeTab, setActiveTab] = useState<DebugTab>("Overview");
  const [filter, setFilter] = useState("");
  const rowsByTab = useMemo(() => buildRows(debug), [debug]);
  const rows = rowsByTab[activeTab].filter((row) => matches(row, filter));

  return (
    <section data-testid="operator-debug-panel" className="operator-debug-panel">
      <header className="operator-debug-toolbar">
        <div className="operator-segmented" aria-label="Debug sections">
          {tabs.map((tab) => (
            <button key={tab} type="button" aria-pressed={activeTab === tab} onClick={() => setActiveTab(tab)}>
              {tab}
            </button>
          ))}
        </div>
        <input
          aria-label="Filter debug content"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Search content"
        />
      </header>
      {rows.length === 0 ? (
        <p className="operator-muted">No debug content for this section.</p>
      ) : (
        <ol className="operator-debug-list">
          {rows.map((row) => (
            <li key={row.id}>
              <strong>{row.label}</strong>
              {row.meta ? <span>{row.meta}</span> : null}
              <pre>{stringify(row.body)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function buildRows(debug: OperatorTaskDebug): Record<DebugTab, DebugRow[]> {
  const groups = debug.data.debug;
  const resources = debug.data.resources;
  const artifacts = groups?.artifacts?.refs ?? debug.data.artifacts;
  const sessionHistory = groups?.session?.history ?? debug.data.history;
  const packets = groups?.context?.packets ?? resources.filter((item) => item.resourceType === "context_packet");
  const envelopes = groups?.envelope?.envelopes ?? resources.filter((item) => item.resourceType === "task_envelope");
  const selectedMemories = groups?.memory?.selectedMemories ?? latestPacketBlocks(packets, "selectedMemories");
  const priorArtifacts = groups?.artifacts?.priorArtifacts ?? latestPacketBlocks(packets, "priorArtifacts");

  return {
    Overview: [
      {
        id: "overview",
        label: `${debug.data.task.taskKey} · ${debug.data.task.status}`,
        body: {
          task: debug.data.task,
          counts: {
            sessionEvents: sessionHistory.length,
            contextPackets: packets.length,
            envelopes: envelopes.length,
            memories: selectedMemories.length + (groups?.memory?.items?.length ?? 0),
            artifacts: priorArtifacts.length + artifacts.length,
            resources: resources.length,
          },
        },
      },
    ],
    Session: [
      {
        id: "session-ids",
        label: "Session ids",
        body: {
          rootSessionId: groups?.session?.rootSessionId ?? debug.data.task.rootSessionId,
          sessionIds: groups?.session?.sessionIds ?? [],
          rawEventRefs: groups?.session?.rawEventRefs ?? [],
        },
      },
      ...(groups?.session?.checkpoints ?? resources.filter((item) => item.resourceType === "session_checkpoint")).map(resourceRow),
      ...sessionHistory.map(historyRow),
    ],
    Context: [
      ...packets.map(resourceRow),
      ...(groups?.context?.assemblyTraces ?? resources.filter((item) => item.resourceType === "context_assembly_trace")).map(resourceRow),
    ],
    Envelope: envelopes.map(resourceRow),
    Memory: [
      ...selectedMemories.map((item, index) => unknownRow("selected-memory", index, item)),
      ...(groups?.memory?.items ?? resources.filter((item) => item.resourceType === "memory_item")).map(resourceRow),
      ...(groups?.memory?.deltas ?? resources.filter((item) => item.resourceType === "memory_delta")).map(resourceRow),
    ],
    Artifacts: [
      ...priorArtifacts.map((item, index) => unknownRow("prior-artifact", index, item)),
      ...artifacts.map(resourceRow),
    ],
    Resources: Object.entries(groups?.resources ?? groupedResources(resources)).flatMap(([group, items]) =>
      (items ?? []).map((item) => resourceRow(item, group)),
    ),
    Raw: [
      {
        id: "raw-task-debug",
        label: "Full task debug model",
        body: debug.data,
      },
    ],
  };
}

function resourceRow(item: OperatorResourceItem, group?: string | number): DebugRow {
  const groupKey = typeof group === "string" ? group : item.resourceType;
  return {
    id: `${groupKey}:${item.resourceKey}`,
    label: `${item.resourceType} · ${item.status}`,
    meta: [item.title, item.artifactRefId, item.updatedAt].filter(Boolean).join(" · "),
    body: {
      resourceKey: item.resourceKey,
      summary: item.summary,
      payload: item.payload,
      content: item.content,
      contentError: item.contentError,
    },
  };
}

function historyRow(item: OperatorHistoryItem): DebugRow {
  return {
    id: `history:${item.sequence}`,
    label: `${item.eventType} · ${item.actorType}`,
    meta: [item.sessionId, item.createdAt].filter(Boolean).join(" · "),
    body: {
      sequence: item.sequence,
      runId: item.runId,
      taskId: item.taskId,
      sessionId: item.sessionId,
      payload: item.payload,
    },
  };
}

function unknownRow(prefix: string, index: number, item: unknown): DebugRow {
  const record = asRecord(item);
  return {
    id: `${prefix}:${index}:${stringValue(record.id) ?? index}`,
    label: stringValue(record.title) ?? stringValue(record.sourceType) ?? prefix,
    meta: stringValue(record.sourceRef),
    body: item,
  };
}

function latestPacketBlocks(packets: OperatorResourceItem[], key: "selectedMemories" | "priorArtifacts"): unknown[] {
  const payload = asRecord(packets[0]?.payload);
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

function groupedResources(resources: OperatorResourceItem[]): Record<string, OperatorResourceItem[]> {
  return resources.reduce<Record<string, OperatorResourceItem[]>>((groups, item) => {
    const group = item.resourceType;
    groups[group] = [...(groups[group] ?? []), item];
    return groups;
  }, {});
}

function matches(row: DebugRow, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return `${row.label}\n${row.meta ?? ""}\n${stringify(row.body)}`.toLowerCase().includes(needle);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
