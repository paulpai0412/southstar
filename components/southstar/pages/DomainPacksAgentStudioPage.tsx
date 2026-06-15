"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function DomainPacksAgentStudioPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { void api.getUiDomainPacks("software").then(setModel); }, [api]);
  return <SouthstarShell title="Domain Packs / Agent Studio"><div className="ss-page-grid"><Panel title="Domain Packs"><CodeBlock value={model?.domainPacks ?? []} /></Panel><Panel title="DSL Viewer"><CodeBlock value={model?.selectedPack?.dslText ?? ""} /></Panel><Panel title="Agent Profiles"><CodeBlock value={model?.selectedPack?.agentProfiles ?? []} /></Panel><Panel title="Artifact Contract"><CodeBlock value={model?.selectedPack?.artifactContracts ?? []} /></Panel><Panel title="Evaluator Pipeline"><CodeBlock value={model?.selectedPack?.evaluatorPipeline ?? []} /></Panel><Panel title="Workflow Preview"><CodeBlock value={model?.workflowPreviews ?? []} /></Panel><Panel title="Validation Diagnostics"><CodeBlock value={model?.validationDiagnostics ?? []} /></Panel></div></SouthstarShell>;
}
