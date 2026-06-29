import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Sandbox, SandboxExecResult } from "./sandbox.js";

function getErrorOutput(error: unknown): SandboxExecResult {
  const stdout =
    error instanceof Error && "stdout" in error ? String(error.stdout || "") : "";
  const stderr =
    error instanceof Error && "stderr" in error ? String(error.stderr || "") : "";
  const status =
    error instanceof Error && "status" in error ? Number(error.status) : 1;
  const message = error instanceof Error ? error.message : String(error);

  return {
    stdout: stdout || stderr || message || "",
    exitCode: status || 1,
  };
}

export function createLocalSandbox(dir: string): Sandbox {
  return {
    type: "local",
    workingDirectory: dir,
    readFile: async (path) => readFileSync(resolve(dir, path), "utf-8"),
    exec: async (command) => {
      try {
        const stdout = execSync(command, {
          cwd: dir,
          encoding: "utf-8",
          timeout: 30_000,
        });

        return { stdout, exitCode: 0 };
      } catch (error) {
        return getErrorOutput(error);
      }
    },
    stop: async () => {},
  };
}
