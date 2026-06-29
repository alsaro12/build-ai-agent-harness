export interface PromptContext {
  workingDirectory: string;
  sandboxType: string;
  toolNames: string[];
  gitBranch?: string;
  projectContext?: string;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  sections.push(`You are a coding agent working in: ${ctx.workingDirectory}`);
  sections.push(`Sandbox: ${ctx.sandboxType}`);

  sections.push(`
# Agency
- USE your tools. Read files, search code, run commands, then answer.
- Do NOT explain what you WOULD do. Actually do it.
- Available tools: ${ctx.toolNames.join(", ")}
- Prefer grep for searching across files and read for viewing known files.
- Use bash only for shell-command requests or tasks not covered by other tools.
- If a requested command is unsafe, call bash with the exact command and report the block message honestly.`);

  if (ctx.gitBranch) {
    sections.push(`- Current branch: ${ctx.gitBranch}`);
  }

  sections.push(`
# Guardrails
- Prefer simple, minimal changes.
- Search before creating, and reuse existing patterns.
- No new dependencies without asking.
- Keep work scoped to the working directory unless the user explicitly asks otherwise.`);

  if (ctx.projectContext) {
    sections.push(`
# Project Instructions (from AGENTS.md)
${ctx.projectContext}`);
  }

  return sections.join("\n");
}
