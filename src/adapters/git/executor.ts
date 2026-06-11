export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommand {
  command: string;
  args: string[];
}

export interface GitCommandRunner {
  (command: GitCommand): Promise<ProcessResult>;
}

export class GitOperationError extends Error {
  readonly code: string;
  readonly retryable?: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "GitOperationError";
    this.code = code;
    this.retryable = options.retryable;
  }
}
