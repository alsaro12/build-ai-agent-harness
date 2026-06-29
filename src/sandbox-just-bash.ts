import { Sandbox as JustBashSandbox } from "just-bash";
import type { Sandbox, SandboxExecResult } from "./sandbox.js";

const MOUNT = "/home/user/project";

function toVirtualPath(path: string): string {
  const relativePath = path === "." ? "" : path.replace(/^\/+/, "");

  return relativePath ? `${MOUNT}/${relativePath}` : MOUNT;
}

function getErrorOutput(error: unknown): SandboxExecResult {
  const message = error instanceof Error ? error.message : String(error);

  return { stdout: message || "", exitCode: 1 };
}

export async function createJustBashSandbox(dir: string): Promise<Sandbox> {
  const jb = await JustBashSandbox.create({ overlayRoot: dir });

  return {
    type: "just-bash",
    workingDirectory: dir,
    readFile: async (path) => jb.readFile(toVirtualPath(path)),
    exec: async (command) => {
      try {
        const cmd = await jb.runCommand(command, { cwd: MOUNT });

        return {
          stdout: await cmd.output(),
          exitCode: cmd.exitCode,
        };
      } catch (error) {
        return getErrorOutput(error);
      }
    },
    stop: async () => {
      await jb.stop();
    },
  };
}
