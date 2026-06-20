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
