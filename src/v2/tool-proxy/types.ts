export type VaultLease = {
  id: string;
  runId: string;
  sessionId: string;
  secretRef: string;
  allowedTools: string[];
  expiresAt: string;
  secretDigest?: string;
};

export type IssueVaultLeaseInput = {
  id?: string;
  runId: string;
  taskId?: string;
  sessionId: string;
  secretRef: string;
  plaintextSecret: string;
  allowedTools: string[];
  ttlSeconds: number;
  reason: string;
};

export type Vault = {
  issueLease(input: IssueVaultLeaseInput): Promise<VaultLease>;
  getLease(resourceKey: string): Promise<VaultLease | null>;
};

export type ToolProxyCallInput = {
  runId: string;
  sessionId: string;
  leaseId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ToolProxyCallContext = {
  lease: VaultLease;
  toolName: string;
};

export type ToolHandler = (input: Record<string, unknown>, context: ToolProxyCallContext) => Promise<unknown>;

export type ToolProxyResult = {
  ok: boolean;
  output: string;
  summary: Record<string, unknown>;
};

export type ToolProxy = {
  execute(input: ToolProxyCallInput): Promise<ToolProxyResult>;
};

export type ToolProxyViolationReason =
  | "raw_credential_in_context"
  | "raw_credential_in_envelope"
  | "direct_tool_without_proxy"
  | "callback_payload_leak"
  | "missing_required_lease"
  | "expired_lease";

export type ToolProxyPolicyPayload = {
  schemaVersion: "southstar.tool_proxy_policy.v1";
  runId: string;
  sessionId: string;
  allowedTools: string[];
  requiredProxyTools: string[];
  forbiddenDirectEnvKeys: string[];
  vaultLeaseRefs: string[];
  maxLeaseTtlSeconds: number;
  redactResultPayloads: true;
  failClosed: true;
};

export type ToolProxyViolationPayload = {
  schemaVersion: "southstar.tool_proxy_violation.v1";
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId?: string;
  severity: "blocking" | "warning";
  reason: ToolProxyViolationReason;
  evidenceRef: string;
  redactedExcerpt?: string;
  detectedAt: string;
};
