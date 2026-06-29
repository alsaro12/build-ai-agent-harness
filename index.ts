import { execSync } from "node:child_process";
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
const MAX_MATCHES = 50;

function resolveProjectPath(filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);

  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Refusing to read outside working directory: ${filePath}`);
  }

  return abs;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatGrepOutput(stdout: string): string {
  const lines = stdout.trim().split("\n").filter(Boolean);

  if (lines.length === 0) {
    return "No matches found.";
  }

  const truncated = lines.length > MAX_MATCHES;
  const result = truncated ? lines.slice(0, MAX_MATCHES) : lines;
  const output = result.join("\n");

  return truncated
    ? `${output}\n... (${lines.length} total, showing first ${MAX_MATCHES})`
    : `${output}\n... (${lines.length} total matches)`;
}

const read = tool({
  description: `Read a file from the project. Returns numbered lines.
WHEN TO USE: viewing the contents of a specific known file, checking configs, reading source code after a path is known.
WHEN NOT TO USE: searching across files, finding TODOs, locating imports, or discovering where code exists (use grep instead).
DO NOT USE FOR: running commands, listing directories, broad project exploration, or regex/content search.
EXAMPLES:
  - Read package metadata: path "package.json"
  - Inspect compiler config: path "tsconfig.json" limit 80
  - Read part of a source file: path "index.ts" offset 20 limit 40`,
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

const grep = tool({
  description: `Search file contents using regex. Returns matching lines with file paths and line numbers.
WHEN TO USE: finding patterns across multiple files, locating function definitions, searching imports, finding TODO comments, finding error messages.
WHEN NOT TO USE: reading a known file once the path is already known (use read instead).
DO NOT USE FOR: running commands, listing directories, editing files, or opening full files.
EXAMPLES:
  - Find all TODO comments: pattern "TODO" glob "*.ts"
  - Find TypeScript imports: pattern "^import" glob "*.ts"
  - Find function definitions: pattern "function [A-Za-z0-9_]+" glob "*.ts"`,
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z
      .string()
      .optional()
      .describe("Directory or file to search, relative to the working directory"),
    glob: z
      .string()
      .optional()
      .describe("File glob filter, e.g. '*.ts' or '*.md'"),
  }),
  execute: async ({ pattern, path: searchPath, glob: globFilter }) => {
    const target = resolveProjectPath(searchPath || ".");
    const include = globFilter || "*";
    const cmd = [
      "grep",
      "-rn",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      `--include=${shellQuote(include)}`,
      "-E",
      shellQuote(pattern),
      shellQuote(target),
    ].join(" ");

    try {
      const stdout = execSync(cmd, { encoding: "utf-8", timeout: 10_000 });

      return formatGrepOutput(stdout);
    } catch (error) {
      const stdout =
        error instanceof Error && "stdout" in error
          ? String(error.stdout || "")
          : "";

      return formatGrepOutput(stdout);
    }
  },
});

const agent = new ToolLoopAgent({
  model: "anthropic/claude-haiku-4-5",
  instructions: `You are a coding agent.
Working directory: ${cwd}

Use grep to search across files. Use read to inspect a specific known file.`,
  tools: noTools ? {} : { read, grep },
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
