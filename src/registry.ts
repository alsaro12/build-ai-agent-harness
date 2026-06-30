import { tool, type Tool } from "ai";

export interface ToolRegistry {
  register(name: string, tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): string[];
  entries(): [string, Tool][];
}

export type BuiltinTools = Record<
  "read" | "grep" | "bash" | "task" | "askUser" | "todo" | "loadSkill",
  Tool
>;

interface WrapHooks {
  beforeExecute?: (input: unknown) => unknown | Promise<unknown>;
  afterExecute?: (result: unknown) => unknown | Promise<unknown>;
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    register: (name, registeredTool) => {
      tools.set(name, registeredTool);
    },
    get: (name) => tools.get(name),
    list: () => [...tools.keys()],
    entries: () => [...tools.entries()],
  };
}

export function registerBuiltins(
  registry: ToolRegistry,
  builtins: BuiltinTools,
) {
  registry.register("read", builtins.read);
  registry.register("grep", builtins.grep);
  registry.register("bash", builtins.bash);
  registry.register("task", builtins.task);
  registry.register("askUser", builtins.askUser);
  registry.register("todo", builtins.todo);
  registry.register("loadSkill", builtins.loadSkill);
}

export function wrapTool(base: Tool, hooks: WrapHooks): Tool {
  return tool({
    description: base.description,
    inputSchema: base.inputSchema,
    execute: async (input) => {
      const transformed = hooks.beforeExecute
        ? await hooks.beforeExecute(input)
        : input;
      const result = await base.execute?.(transformed, {
        toolCallId: "wrapped-tool-call",
        messages: [],
      });

      return hooks.afterExecute ? hooks.afterExecute(result) : result;
    },
  });
}
