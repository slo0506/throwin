import type Anthropic from "@anthropic-ai/sdk";
import { GmComponentKind } from "@throwin/shared";
import { z } from "zod";
import type { StoredMessage } from "./data.js";

// What the server stores next to the API-native content in `messages.tool_calls`, so a
// conversation can be rebuilt (allow-list, cards, mode) without re-parsing text.

export const ResolvedTargetData = z.object({
  kind: z.enum(["exact", "category"]),
  name: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  category: z.string().nullable(),
  constraints: z.array(z.string()),
  anchor: z
    .object({
      retail_cents: z.number().int().nonnegative().nullable(),
      used_low_cents: z.number().int().nonnegative(),
      used_high_cents: z.number().int().nonnegative(),
    })
    .nullable(),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.object({ name: z.string(), detail: z.string() })),
  /** A reference product photo from a cited page (product-image.ts). Older rows have none. */
  image_url: z.string().nullable().default(null),
});
export type ResolvedTargetData = z.infer<typeof ResolvedTargetData>;

export const ToolCallRecord = z.object({
  tool_use_id: z.string(),
  name: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  error_code: z.string().optional(),
  /** IDs this call returned to the model. They join the session's allow-list. */
  issued_ids: z.array(z.string()).optional(),
  /** The card this call rendered. Rebuilt from `input` when history is loaded. */
  component: z
    .object({
      id: z.string(),
      kind: GmComponentKind,
      /** Choice option IDs, or the Item IDs of a selectable card. */
      option_ids: z.array(z.string()).optional(),
      /** Rendered data for cards the server cannot refetch (choices, camera, recap). */
      data: z.unknown().optional(),
    })
    .optional(),
  /** resolve_target only: the target the server keeps so upsert_ask cannot invent one. */
  target: z.object({ target_id: z.string(), data: ResolvedTargetData }).optional(),
  /** Whole-dollar amounts the result showed the model (the grounding check). */
  amounts: z.array(z.number()).optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const UserInputRecord = z.object({
  kind: z.literal("user_input"),
  display_text: z.string(),
  choice: z.object({ component_id: z.string(), option_ids: z.array(z.string()) }).optional(),
  media_paths: z.array(z.string()).optional(),
  added_item_ids: z.array(z.string()).optional(),
});
export type UserInputRecord = z.infer<typeof UserInputRecord>;

export const AssistantRecord = z.object({
  kind: z.literal("tool_calls"),
  calls: z.array(ToolCallRecord),
});

export const RowMeta = z.union([
  UserInputRecord,
  AssistantRecord,
  z.object({ kind: z.literal("tool_results") }),
  z.object({ kind: z.literal("greeting") }),
]);
export type RowMeta = z.infer<typeof RowMeta>;

export function rowMeta(row: StoredMessage): RowMeta | null {
  const parsed = RowMeta.safeParse(row.toolCalls);
  return parsed.success ? parsed.data : null;
}

export function toolCallsOf(row: StoredMessage): ToolCallRecord[] {
  const meta = rowMeta(row);
  return meta?.kind === "tool_calls" ? meta.calls : [];
}

export const isUserInput = (row: StoredMessage) =>
  row.role === "user" && rowMeta(row)?.kind === "user_input";

export function finishedIntakeIn(rows: StoredMessage[]): boolean {
  return rows.some((r) => toolCallsOf(r).some((c) => c.name === "finish_intake" && c.ok));
}

/**
 * Drops leading rows until the first user input, so a trimmed window never starts with a
 * tool result whose tool_use was cut off. Greetings before the first input are kept.
 */
export function trimToTurnStart(rows: StoredMessage[]): StoredMessage[] {
  const first = rows.findIndex((r) => isUserInput(r) || rowMeta(r)?.kind === "greeting");
  return first <= 0 ? rows : rows.slice(first);
}

/** Merges consecutive same-role messages, which the Messages API expects to alternate. */
export function mergeRoles(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const blocks =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
    } else {
      out.push({ role: m.role, content: [...blocks] });
    }
  }
  return out;
}

export const toApiMessages = (rows: StoredMessage[]): Anthropic.MessageParam[] =>
  rows.map((r) => ({ role: r.role, content: structuredClone(r.content) }));

/** The text the user saw from an assistant row. */
export const textOf = (content: Anthropic.ContentBlockParam[]) =>
  content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("");

export interface ClientGroup {
  role: "user" | "assistant";
  id: string;
  text: string;
  calls: ToolCallRecord[];
  createdAt: Date;
}

/**
 * Groups stored rows the way the app shows them: 1 bubble per user input, and 1 per
 * assistant turn (all its steps, tool results hidden). An assistant group takes the ID of
 * its last row, which is the `message_id` the stream's `done` event carried.
 */
export function groupForClient(rows: StoredMessage[]): ClientGroup[] {
  const out: ClientGroup[] = [];
  let current: ClientGroup | null = null;
  for (const row of rows) {
    const meta = rowMeta(row);
    if (row.role === "user" && meta?.kind === "user_input") {
      current = null;
      out.push({
        role: "user",
        id: row.id,
        text: meta.display_text,
        calls: [],
        createdAt: row.createdAt,
      });
      continue;
    }
    if (row.role === "user") continue; // tool results
    const text = textOf(row.content);
    if (!current) {
      current = { role: "assistant", id: row.id, text: "", calls: [], createdAt: row.createdAt };
      out.push(current);
    }
    current.id = row.id;
    if (text.trim()) current.text = current.text ? `${current.text}\n\n${text}` : text;
    current.calls.push(...toolCallsOf(row));
  }
  return out;
}

/** component ID → the option IDs the user picked on it, from later user inputs. */
export function choicesMade(rows: StoredMessage[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const meta = rowMeta(row);
    if (meta?.kind === "user_input" && meta.choice) {
      out.set(meta.choice.component_id, meta.choice.option_ids);
    }
  }
  return out;
}
