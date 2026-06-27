import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";

const args = process.argv.slice(2);
const noTools = args.includes("--no-tools");
const filteredArgs = args.filter((arg) => arg !== "--no-tools");

const cwd = resolve(filteredArgs[0] || process.cwd());
const prompt = filteredArgs.slice(1).join(" ") || "Hello!";
const MAX_LINES = 500;

function resolveProjectPath(filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);

  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Refusing to read outside working directory: ${filePath}`);
  }

  return abs;
}

const read = tool({
  description: `Read a file from the project. Returns numbered lines.
WHEN TO USE: viewing file contents, checking configs, reading source code.
WHEN NOT TO USE: searching across files (use grep instead).`,
  inputSchema: z.object({
    path: z.string().describe("File path relative to working directory"),
    offset: z.number().optional().describe("Start line (1-indexed)"),
    limit: z.number().optional().describe("Max lines to return"),
  }),
  execute: async ({ path: filePath, offset, limit }) => {
    const abs = resolveProjectPath(filePath);
    const content = readFileSync(abs, "utf-8");
    let lines = content.split("\n");
    const startLine = offset || 1;

    if (offset) {
      lines = lines.slice(offset - 1);
    }

    if (limit) {
      lines = lines.slice(0, limit);
    }

    const truncated = lines.length > MAX_LINES;

    if (truncated) {
      lines = lines.slice(0, MAX_LINES);
    }

    const numbered = lines.map((line, index) => `${startLine + index}: ${line}`);
    const output = numbered.join("\n");

    return truncated
      ? `${output}\n... (truncated at ${MAX_LINES} lines)`
      : output;
  },
});

const agent = new ToolLoopAgent({
  model: "anthropic/claude-haiku-4-5",
  instructions: `You are a coding agent.
Working directory: ${cwd}

When you need to inspect a known file, use the read tool.`,
  tools: noTools ? {} : { read },
  stopWhen: stepCountIs(10),
});

try {
  const { text, steps } = await agent.generate({ prompt });

  console.log(text);
  console.log(`\n(${steps.length} steps)`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`Agent run failed: ${message}`);
  process.exitCode = 1;
}
