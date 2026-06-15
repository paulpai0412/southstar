"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function WorktreeConsolePage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("runId") ?? undefined; void api.getUiWorktree(id).then(setModel); }, [api]);
  return <SouthstarShell title="Worktree Console"><div className="ss-page-grid"><Panel title="Snapshot Timeline"><CodeBlock value={model?.snapshots ?? []} /></Panel><Panel title="Worktree Tree"><p>Git workspace snapshot and rollback reference</p></Panel><Panel title="Diff Preview"><CodeBlock value={model?.rollbackPreviews ?? []} /></Panel><Panel title="Operations"><button>Create Snapshot</button><button>Rollback Preview</button><button>Rollback Execute</button></Panel><Panel title="Safety Checks"><CodeBlock value={model?.safetyChecks ?? []} /></Panel><Panel title="Executor Mount Status"><p>{model?.executorMountStatus}</p></Panel></div></SouthstarShell>;
}
