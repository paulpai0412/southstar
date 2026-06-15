export type CubeHostMount = {
  source: string;
  target: string;
  readonly: boolean;
};

export type CubeSandboxStatus = {
  sandboxId: string;
  status: string;
  metadata?: Record<string, string>;
};

export type CubeCommandStatus = {
  commandId: string;
  status: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type CubeLogsResult = {
  text: string;
  cursor?: string;
};

export type CubeSandboxSdkClient = {
  health(): Promise<void>;
  createSandbox(input: {
    templateId: string;
    metadata: Record<string, string>;
    timeoutSeconds: number;
    hostMounts: CubeHostMount[];
  }): Promise<{ sandboxId: string }>;
  runCommand(input: {
    sandboxId: string;
    command: string[];
    env: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<{ commandId: string }>;
  getSandbox(input: { sandboxId: string }): Promise<CubeSandboxStatus>;
  getCommand(input: { sandboxId: string; commandId: string }): Promise<CubeCommandStatus>;
  killCommand(input: { sandboxId: string; commandId: string }): Promise<void>;
  destroySandbox(input: { sandboxId: string }): Promise<void>;
  listSandboxes(input: { metadata?: Record<string, string> }): Promise<CubeSandboxStatus[]>;
  logs(input: { sandboxId: string; commandId?: string; cursor?: string }): Promise<CubeLogsResult>;
};
