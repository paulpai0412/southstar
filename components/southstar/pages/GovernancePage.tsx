"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function GovernancePage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { void api.getUiGovernance().then(setModel); }, [api]);
  return <SouthstarShell title="Vault / MCP / Approval Policy"><div className="ss-page-grid"><Panel title="MCP Connections"><CodeBlock value={model?.mcpConnections ?? []} /></Panel><Panel title="Tool Grant Matrix"><CodeBlock value={model?.toolGrantMatrix ?? []} /></Panel><Panel title="Secrets Vault"><CodeBlock value={model?.secretGroups ?? []} /></Panel><Panel title="Approval Queue"><CodeBlock value={model?.approvalQueue ?? []} /></Panel><Panel title="Audit Log"><CodeBlock value={model?.auditLog ?? []} /></Panel><Panel title="Risk Policy"><CodeBlock value={model?.riskPolicy ?? {}} /></Panel><Panel title="Policy Simulator"><CodeBlock value={model?.policySimulations ?? []} /></Panel><Panel title="Policy Version History"><CodeBlock value={model?.policyHistory ?? []} /></Panel></div></SouthstarShell>;
}
