import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ToolLoopAgent, pruneMessages, stepCountIs, tool } from "ai";
import { z } from "zod";
import { addCacheControl } from "./src/cache.js";
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
const MAX_BASH_CHARS = 5000;
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
const EXECUTOR_TRUSTED_PREFIXES = ["npm test", "npm run build", "npx tsc"];
const SPAWN_PERMISSIONS: Record<string, Array<"explorer" | "executor">> = {
  orchestrator: ["explorer", "executor"],
  executor: ["explorer"],
  explorer: [],
};

type TodoItem = {
  id: string;
  description: string;
  state: "pending" | "in_progress" | "completed";
};

const todos: TodoItem[] = [];

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

function formatBashOutput(stdout: string): string {
  if (stdout.length <= MAX_BASH_CHARS) {
    return stdout;
  }

  return `${stdout.slice(-MAX_BASH_CHARS)}\n... (truncated, showing last ${MAX_BASH_CHARS} chars)`;
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

USAGE: command is a single shell string. The active approval policy decides whether it can run. Interactive mode allows safe prefixes (${SAFE_PREFIXES.join(", ")}) and blocks everything else. Background mode runs without approval. Delegated mode only runs trusted prefixes. Output is capped at ${MAX_BASH_CHARS} characters, keeping the tail. Execution timeout depends on the injected execution backend.

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
      const output = formatBashOutput(stdout || "(no output)");

      if (exitCode !== 0) {
        return `Exit ${exitCode}: ${output}`;
      }

      return output;
    },
  });
}

function createAskUserTool() {
  return tool({
    description: `Ask the user a multiple-choice question and return the pending question to the agent.

WHEN TO USE: scoping ambiguous tasks, choosing between multiple valid approaches, resolving a missing requirement before acting, or selecting one option when guessing would cause wrong work.

WHEN NOT TO USE: the task already includes a precise file path, line number, command, or implementation detail; you can gather enough context with read/grep/bash; or the answer is obvious from project files.

DO NOT USE FOR: rhetorical questions, progress updates, open-ended brainstorming, asking more than one question at a time, or avoiding work that can be done safely.

USAGE: ask exactly one question. Provide 2 to 4 concrete options. The harness returns the question as pending; do not continue implementation until the user answers.`,
    inputSchema: z.object({
      question: z.string().describe("The single question to ask the user"),
      options: z
        .array(z.string())
        .min(2)
        .max(4)
        .describe("Two to four concrete options for the user to choose from"),
    }),
    execute: async ({ question, options }) => {
      const formatted = options
        .map((option, index) => `${index + 1}. ${option}`)
        .join("\n");
      const message = `Question: ${question}\n${formatted}`;

      console.log(`\n${message}\n`);

      return `Asked: "${question}"\nOptions:\n${formatted}\n\n(Awaiting user response.)`;
    },
  });
}

function formatTodos() {
  return (
    todos
      .map((item) => `[${item.state}] ${item.id}: ${item.description}`)
      .join("\n") || "No todos."
  );
}

function createTodoTool() {
  return tool({
    description: `Manage a task list for multi-step work. Enforces one active item at a time.

WHEN TO USE: tasks with 3+ steps, multiple files, dependent changes, multi-part features, or work where progress must be tracked across several tool calls.

WHEN NOT TO USE: single-file fixes, simple questions, one-step reads, exploratory searches with no concrete outcome, or direct user status updates.

DO NOT USE FOR: replacing actual work with planning, making status updates to the user, tracking trivial tasks, or starting multiple items at once.

USAGE: add creates pending items, start marks one item in_progress, complete marks an item completed, list shows all items. Start rejects if another item is already in_progress.`,
    inputSchema: z.object({
      action: z
        .enum(["add", "start", "complete", "list"])
        .describe("Todo action to perform"),
      description: z
        .string()
        .optional()
        .describe("Todo description for add"),
      id: z
        .string()
        .optional()
        .describe("Todo id for start or complete"),
    }),
    execute: async ({ action, description, id }) => {
      if (action === "add") {
        const item: TodoItem = {
          id: crypto.randomUUID().slice(0, 8),
          description: description ?? "(unnamed)",
          state: "pending",
        };

        todos.push(item);

        return `Added: [${item.id}] ${item.description}`;
      }

      if (action === "start") {
        const active = todos.find((item) => item.state === "in_progress");

        if (active) {
          return `Already working on: [${active.id}] ${active.description}. Complete it first.`;
        }

        const item = todos.find((todo) => todo.id === id);

        if (!item) {
          return `No todo with id ${id}.`;
        }

        item.state = "in_progress";

        return `Started: [${item.id}] ${item.description}`;
      }

      if (action === "complete") {
        const item = todos.find((todo) => todo.id === id);

        if (!item) {
          return `No todo with id ${id}.`;
        }

        item.state = "completed";

        return `Completed: [${item.id}] ${item.description}`;
      }

      return formatTodos();
    },
  });
}

function canSpawn(
  parentRole: string,
  subagentType: "explorer" | "executor",
): boolean {
  return SPAWN_PERMISSIONS[parentRole]?.includes(subagentType) ?? false;
}

function buildExplorer(
  taskSandbox: Sandbox,
  parentTools: { read: typeof read; grep: typeof grep },
) {
  const model = "anthropic/claude-haiku-4-5";
  const stepBudget = 5;

  return new ToolLoopAgent({
    model,
    instructions: `You are an explorer subagent. Investigate the request and report back concisely.
Working directory: ${taskSandbox.workingDirectory}

Rules:
- Use read and grep only.
- Do not attempt to modify files.
- Do not run shell commands.
- Do not ask the user questions.
- Return only findings, relevant file paths, and a concise summary.`,
    tools: { read: parentTools.read, grep: parentTools.grep },
    stopWhen: stepCountIs(stepBudget),
  });
}

function buildExecutor(
  taskSandbox: Sandbox,
  parentTools: { read: typeof read; grep: typeof grep },
) {
  const model = "anthropic/claude-sonnet-4-6";
  const stepBudget = 15;
  const executorBash = createBashTool(
    taskSandbox,
    createApproval({
      mode: "delegated",
      trust: EXECUTOR_TRUSTED_PREFIXES,
    }),
  );

  return new ToolLoopAgent({
    model,
    instructions: `You are an executor subagent. Follow the delegated task precisely.
Working directory: ${taskSandbox.workingDirectory}

Rules:
- Use read and grep only for context required by the task.
- Use bash only for delegated trusted verification commands.
- Do not ask the user questions.
- Do not install dependencies.
- Do not attempt destructive commands.
- Stop and report any blocked command or missing requirement.
- Return only changes made, verification run, relevant file paths, and remaining issues.`,
    tools: {
      read: parentTools.read,
      grep: parentTools.grep,
      bash: executorBash,
    },
    stopWhen: stepCountIs(stepBudget),
  });
}

async function runSubagent(
  role: "Explorer" | "Executor",
  generate: () => Promise<{ text: string; steps: { length: number } }>,
) {
  try {
    const { text, steps } = await generate();

    return text
      ? `[${role}: ${steps.length} steps]\n${text}`
      : `(no response from ${role})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return `${role} error: ${message}`;
  }
}

function createTaskTool(
  taskSandbox: Sandbox,
  parentTools: { read: typeof read; grep: typeof grep },
) {
  return tool({
    description: `Delegate work to a subagent. Returns a concise subagent summary.

ROLES:
- explorer (default): read-only research with a fast model, read and grep only, 5-step budget.
- executor: precise implementation or verification with a stronger model, read, grep, and delegated bash, 15-step budget.

WHEN TO USE: investigating a codebase or finding patterns across many files (explorer), or delegating a precise implementation/verification task after the parent has decided what should happen (executor).

WHEN NOT TO USE: ambiguous requirements (ask the user directly), architectural decisions (the parent decides), or a small direct lookup/change the parent can do itself.

DO NOT USE FOR: destructive actions, package installs, migrations, broad unsupervised changes, or transferring user-question responsibility to a subagent.

USAGE: description must be specific. Use subagentType "explorer" for research and "executor" for precise action. The executor can only run delegated trusted bash prefixes: ${EXECUTOR_TRUSTED_PREFIXES.join(", ")}. Spawn permission checks can be added with canSpawn(parentRole, subagentType) once parent roles are tracked.`,
    inputSchema: z.object({
      description: z
        .string()
        .describe("Specific task instructions for the subagent"),
      subagentType: z
        .enum(["explorer", "executor"])
        .default("explorer")
        .describe("Subagent role to use for this task"),
    }),
    execute: async ({ description, subagentType }) => {
      if (subagentType === "executor") {
        const executor = buildExecutor(taskSandbox, parentTools);

        return runSubagent("Executor", () =>
          executor.generate({ prompt: description }),
        );
      }

      const explorer = buildExplorer(taskSandbox, parentTools);

      return runSubagent("Explorer", () =>
        explorer.generate({ prompt: description }),
      );
    },
  });
}

const approvalConfig = parseApprovalConfig();
const bash = createBashTool(sandbox, createApproval(approvalConfig));
const task = createTaskTool(sandbox, { read, grep });
const askUser = createAskUserTool();
const todo = createTodoTool();
const tools = { read, grep, bash, task, askUser, todo };
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
  prepareCall: async (options) => {
    const pruned = options.messages
      ? pruneMessages({
          messages: options.messages,
          toolCalls: "before-last-3-messages",
        })
      : undefined;

    return {
      ...options,
      messages: pruned ? addCacheControl(pruned) : undefined,
    };
  },
  onStepFinish: ({ usage, stepNumber }) => {
    console.error(
      `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.cachedInputTokens ?? 0} cached`,
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
