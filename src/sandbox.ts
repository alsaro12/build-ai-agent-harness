export interface SandboxExecResult {
  stdout: string;
  exitCode: number;
}

export interface Sandbox {
  type: string;
  workingDirectory: string;
  readFile(path: string): Promise<string>;
  exec(command: string): Promise<SandboxExecResult>;
  stop(): Promise<void>;
}
