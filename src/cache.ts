import type { ModelMessage } from "ai";

export function addCacheControl(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message, index) => {
    if (index === 0 || index < messages.length - 2) {
      return {
        ...message,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      };
    }

    return message;
  });
}
