import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ToolLoopAgent, pruneMessages, stepCountIs, tool } from "ai";
import { z } from "zod";
import { createJustBashSandbox } from "./src/sandbox-just-bash.js";
import { createLocalSandbox } from "./src/sandbox-local.js";
import type { Sandbox, SandboxLifecycle } from "./src/sandbox.js";
import { buildSystemPrompt } from "./src/system.js";

const args = process.argv.slice(2);
const noTools = args.includes("--no-tools");
const approvalArg = args.find((arg) => arg.startsWith("--approval="));
const trustArg = args.find((arg) => arg.startsWith("--trust="));
const filteredArgs = args.filter(
  (arg) =>
    arg !== "--no-tools" &&
    !arg.startsWith("--approval=") &&
    !arg.startsWith("--trust="),
);

const cwd = resolve(filteredArgs[0] || process.cwd());
const prompt = filteredArgs.slice(1).join(" ") || "Hello!";
const sandboxType = process.env.SANDBOX || "local";
const sandbox =
  sandboxType === "just-bash"
    ? await createJustBashSandbox(cwd)
    : createLocalSandbox(cwd);
const lifecycle: SandboxLifecycle = {};
await lifecycle.afterStart?.(sandbox);
const MAX_LINES = 500;
const MAX_MATCHES = 50;
const SAFE_PREFIXES = [
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
  "find",
  "head",
  "tail",
  "wc",
  "git log",
  "git status",
  "git diff",
];
const DANGEROUS_COMMAND_PATTERNS = [
  /[;&|`]/,
  /\$\(/,
  /\b(rm|sudo|chmod|chown|mv|cp|mkdir|touch)\b/,
  /\bfind\b[\s\S]*\b-exec\b/,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|dlx|exec)\b/,
];

function resolveProjectPath(filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);

  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Refusing to read outside working directory: ${filePath}`);
  }

  return rel || ".";
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

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

type ApprovalInput = {
  command: string;
};

type NeedsApproval = (input: ApprovalInput) => boolean;

function startsWithPrefix(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `);
}

function parseApprovalConfig(): ApprovalConfig {
  const mode = approvalArg?.slice("--approval=".length) || "interactive";

  if (mode === "background") {
    return { mode };
  }

  if (mode === "delegated") {
    const trust =
      trustArg
        ?.slice("--trust=".length)
        .split(",")
        .map((prefix) => prefix.trim())
        .filter(Boolean) || [];

    return { mode, trust };
  }

  return { mode: "interactive" };
}

function createApproval(config: ApprovalConfig): NeedsApproval {
  return ({ command }) => {
    const trimmed = command.trim();

    if (config.mode === "background") {
      return false;
    }

    if (config.mode === "delegated") {
      return !config.trust.some((prefix) => startsWithPrefix(trimmed, prefix));
    }

    if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      return true;
    }

    return !SAFE_PREFIXES.some((prefix) => startsWithPrefix(trimmed, prefix));
  };
}

const read = tool({
  description: `Read one known project file. Returns numbered lines from that file.

WHEN TO USE: viewing file contents, checking configuration files, reading source code after a path is known, examining specific lines with offset and limit.

WHEN NOT TO USE: searching for patterns across files (use grep instead), listing directories or checking git state (use bash instead), broad project exploration before a path is known (use grep or bash instead).

DO NOT USE FOR: regex/content search, directory listings, command execution, file edits, writes, deletes, or discovering unknown files.

USAGE: path is required and must be relative to the working directory. offset is optional and 1-indexed. limit is optional. Output is capped at ${MAX_LINES} lines.

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
    const content = await sandbox.readFile(abs);
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
  description: `Search project file contents using regex. Returns matching lines with file paths and line numbers.

WHEN TO USE: finding patterns across multiple files, locating function definitions, searching imports, finding TODO comments, finding error messages.

WHEN NOT TO USE: reading a known file once the path is already known (use read instead), listing directories or checking git state (use bash instead), running shell commands (use bash instead).

DO NOT USE FOR: opening full files, directory listings, command execution, file edits, writes, deletes, or non-content filesystem discovery.

USAGE: pattern is a required regex string. path is optional and defaults to the working directory. glob is optional and filters matched files, e.g. "*.ts". Results exclude node_modules and .git, and are capped at ${MAX_MATCHES} matches.

EXAMPLES:
  - Find all TODO comments: pattern "TODO" glob "*.ts"
  - Find TypeScript imports: pattern "^import" glob "*.ts"
  - Find imports of a package: pattern "from 'ai'" glob "*.ts"`,
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

    const { stdout } = await sandbox.exec(cmd);

    return formatGrepOutput(stdout);
  },
});

function createBashTool(
  operations: Pick<Sandbox, "exec">,
  needsApproval: NeedsApproval,
) {
  return tool({
    description: `Execute one safe shell command in the working directory. Returns stdout, exit output, or a clear block message.

WHEN TO USE: listing files, checking current directory, checking git status/log/diff, counting files, inspecting command availability, or handling an explicit user request to run a shell command.

WHEN NOT TO USE: reading a known file's contents (use read instead), searching file contents or patterns (use grep instead), modifying project files or installing packages without approval.

DO NOT USE FOR: silently rewriting blocked commands, bypassing approval, shell pipelines, command chaining, destructive commands, package installation, writes, deletes, moves, chmod/chown, sudo, or commands outside the working directory.

USAGE: command is a single shell string. The active approval policy decides whether it can run. Interactive mode allows safe prefixes (${SAFE_PREFIXES.join(", ")}) and blocks everything else. Background mode runs without approval. Delegated mode only runs trusted prefixes. Execution timeout depends on the injected execution backend.

EXAMPLES:
  - List files: command "ls -la"
  - Show current directory: command "pwd"
  - Check git state: command "git status --short"
  - Test whether a destructive command is allowed: command "rm -rf node_modules"`,
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (needsApproval({ command })) {
        return `Blocked: "${command}" requires approval.`;
      }

      const { stdout, exitCode } = await operations.exec(command);

      if (exitCode !== 0) {
        return `Exit ${exitCode}: ${stdout || "(no output)"}`;
      }

      return stdout || "(no output)";
    },
  });
}

const approvalConfig = parseApprovalConfig();
const bash = createBashTool(sandbox, createApproval(approvalConfig));
const tools = { read, grep, bash };
const activeTools = noTools ? {} : tools;
const agentsPath = join(cwd, "AGENTS.md");
const projectContext = existsSync(agentsPath)
  ? readFileSync(agentsPath, "utf-8")
  : undefined;
const instructions = buildSystemPrompt({
  workingDirectory: sandbox.workingDirectory,
  sandboxType: sandbox.type,
  toolNames: Object.keys(activeTools),
  projectContext,
});

const agent = new ToolLoopAgent({
  model: "anthropic/claude-haiku-4-5",
  instructions,
  tools: activeTools,
  stopWhen: stepCountIs(15),
  prepareCall: async (options) => ({
    ...options,
    messages: options.messages
      ? pruneMessages({
          messages: options.messages,
          toolCalls: "before-last-3-messages",
        })
      : undefined,
  }),
  onStepFinish: ({ usage, stepNumber }) => {
    console.error(
      `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output`,
    );
  },
});

try {
  const { text, steps } = await agent.generate({ prompt });

  console.log(text);
  console.log(`\n(${steps.length} steps)`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`Agent run failed: ${message}`);
  process.exitCode = 1;
} finally {
  await lifecycle.beforeStop?.(sandbox);
  await sandbox.stop();
}
