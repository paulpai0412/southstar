export interface IssuePacket {
  issue_number: string;
  title: string;
  source: "github" | "local";
  source_url: string;
  branch: string;
  base_branch: string;
  labels: string[];
  dependencies: string[];
  raw_text: string;
  ready_for_agent: boolean;
}

export function issuePacketId(packet: IssuePacket): string {
  return `${packet.source}:${packet.issue_number}`;
}
