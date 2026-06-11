import { readFile } from "node:fs/promises";
import { parseYamlSubset } from "../config/load-config.ts";
import type { IssuePacket } from "./types.ts";

export async function loadLocalIssuePackets(paths: string[]): Promise<IssuePacket[]> {
  const packets: IssuePacket[] = [];
  for (const path of paths) {
    const parsed = parseYamlSubset(await readFile(path, "utf8"));
    packets.push(normalizeLocalIssuePacket(parsed));
  }
  return packets;
}

function normalizeLocalIssuePacket(value: unknown): IssuePacket {
  const record = recordValue(value);
  return {
    issue_number: String(record.issue_number),
    title: String(record.title),
    source: "local",
    source_url: String(record.source_url),
    branch: String(record.branch),
    base_branch: String(record.base_branch),
    labels: stringArrayValue(record.labels),
    dependencies: stringArrayValue(record.dependencies),
    raw_text: String(record.raw_text),
    ready_for_agent: record.ready_for_agent === true,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Issue packet must be a mapping");
  }
  return value as Record<string, unknown>;
}

function stringArrayValue(value: unknown): string[] {
  if (value === "[]") {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}
