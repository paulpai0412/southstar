"use client";

import { useEffect, useMemo, useState } from "react";
import { CodeBlock } from "../ui/CodeBlock";
import { Panel } from "../ui/Panel";

type WikiLink = { edgeId?: string; fromNodeId?: string; toNodeId?: string; relation?: string; status?: string } & Record<string, unknown>;
type WikiPage = {
  nodeId: string;
  title: string;
  summary: string;
  forwardLinks: WikiLink[];
  backlinks: WikiLink[];
  evidenceLinks: WikiLink[];
  runtimeUsageLinks: WikiLink[];
  downstreamImpactLinks: WikiLink[];
  conflictLinks: WikiLink[];
  supersessionLinks: WikiLink[];
};

export function KnowledgeWikiPanel(props: { nodeId?: string; initialPage?: WikiPage | null }) {
  const [page, setPage] = useState<WikiPage | null>(props.initialPage ?? null);
  const [commandResult, setCommandResult] = useState<unknown>(null);
  const nodeId = props.nodeId ?? props.initialPage?.nodeId;
  const baseUrl = useMemo(() => process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001", []);

  const refresh = () => {
    if (!nodeId) return;
    fetch(`${baseUrl}/api/v2/evolution/wiki/${encodeURIComponent(nodeId)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("wiki page request failed")))
      .then((envelope) => setPage(envelope.result))
      .catch(() => setPage(null));
  };

  useEffect(() => {
    refresh();
  }, [baseUrl, nodeId]);

  const runCommand = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "operator-ui", reason: "Knowledge Wiki moderation", ...body }),
    });
    const payload = await response.json();
    setCommandResult(payload);
    refresh();
  };

  const selectedLinkId = firstEdgeId(page?.forwardLinks) ?? firstEdgeId(page?.backlinks) ?? firstEdgeId(page?.conflictLinks);
  const firstConflict = page?.conflictLinks?.find((link) => typeof link.edgeId === "string");

  return (
    <div className="ss-evolution-wiki-grid">
      <Panel title="Knowledge Wiki">
        <p className="ss-muted">Graph-backed wiki page projection. Links are derived from the learning graph.</p>
        <strong>{page?.title ?? "Select a Knowledge Card"}</strong>
        <p>{page?.summary ?? "Backlinks are derived by reversing learning_edges."}</p>
        <div className="ss-command-row" role="toolbar" aria-label="Wiki moderation commands">
          <button type="button" disabled={!selectedLinkId} onClick={() => selectedLinkId && runCommand(`/api/v2/evolution/wiki/links/${encodeURIComponent(selectedLinkId)}/approve`)}>Approve link</button>
          <button type="button" disabled={!selectedLinkId} onClick={() => selectedLinkId && runCommand(`/api/v2/evolution/wiki/links/${encodeURIComponent(selectedLinkId)}/reject`)}>Reject link</button>
          <button type="button" disabled={!nodeId} onClick={() => nodeId && runCommand(`/api/v2/evolution/wiki/${encodeURIComponent(nodeId)}/normalize-aliases`)}>Normalize aliases</button>
          <button type="button" onClick={() => runCommand("/api/v2/evolution/wiki/maintenance/rewire-stale")}>Rewire stale backlinks</button>
          <button type="button" disabled={!page?.nodeId || !firstConflict?.toNodeId} onClick={() => page?.nodeId && firstConflict?.toNodeId && runCommand("/api/v2/evolution/wiki/conflicts", { fromNodeId: page.nodeId, toNodeId: firstConflict.toNodeId, evidenceNodeRefs: [page.nodeId] })}>Open conflict</button>
          <button type="button" disabled={!selectedLinkId} onClick={() => selectedLinkId && runCommand(`/api/v2/evolution/wiki/conflicts/${encodeURIComponent(selectedLinkId)}/resolve`, { resolution: "superseded" })}>Resolve conflict</button>
        </div>
        <CodeBlock value={commandResult ?? { status: "waiting-for-wiki-command" }} />
      </Panel>
      <Panel title="Forward links"><CodeBlock value={page?.forwardLinks ?? []} /></Panel>
      <Panel title="Backlinks"><CodeBlock value={page?.backlinks ?? []} /></Panel>
      <Panel title="Evidence"><CodeBlock value={page?.evidenceLinks ?? []} /></Panel>
      <Panel title="Runtime usage"><CodeBlock value={page?.runtimeUsageLinks ?? []} /></Panel>
      <Panel title="Downstream impact"><CodeBlock value={page?.downstreamImpactLinks ?? []} /></Panel>
      <Panel title="Conflicts"><CodeBlock value={page?.conflictLinks ?? []} /></Panel>
      <Panel title="Supersession"><CodeBlock value={page?.supersessionLinks ?? []} /></Panel>
    </div>
  );
}

function firstEdgeId(links: WikiLink[] | undefined): string | undefined {
  return links?.find((link) => typeof link.edgeId === "string")?.edgeId;
}
