export function normalizePrompt(prompt: string): string {
  // TODO: collapse repeated whitespace before sending the prompt to the agent.
  return prompt.trim();
}

export function shouldInspectFile(path: string): boolean {
  // TODO: add ignore rules for generated files once the sandbox abstraction exists.
  return path.length > 0;
}
