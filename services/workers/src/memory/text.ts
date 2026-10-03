/** A stored GM chat message (public.messages), content in API-native form. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: unknown;
  createdAt: Date;
}

export interface TurnLine {
  role: "user" | "assistant";
  text: string;
}

/** Characters of text kept per message. Long pastes are cut, not dropped. */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * The plain text a person or the GM wrote in 1 message. Only top-level text blocks count:
 * tool_use inputs and tool_result contents (which can hold another user's Item text) are
 * skipped entirely, so nothing from a tool can ever become a fact about this user.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join("\n");
}

/** The turn as user and GM lines, oldest first, without empty or tool-only messages. */
export function turnLines(messages: StoredMessage[]): TurnLine[] {
  return [...messages]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .flatMap((m) => {
      if (m.role !== "user" && m.role !== "assistant") return [];
      const text = messageText(m.content).slice(0, MAX_MESSAGE_CHARS);
      return text ? [{ role: m.role, text }] : [];
    });
}
