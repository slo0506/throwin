import type Anthropic from "@anthropic-ai/sdk";
import type { GmData, GmUser } from "./data.js";
import { askTitle, clean, dollarAmounts } from "./format.js";
import { mergeRoles } from "./history.js";
import type { CreateParams } from "./model.js";
import type { GmPrompts } from "./prompts.js";
import type { GmSession } from "./session.js";
import { ownItemText } from "./tools/text.js";

const EPHEMERAL = { type: "ephemeral" } as const;
const SHELF_LINES = 30;

/**
 * The session block: who the user is, their always-on facts, Shelf and open Asks, and the
 * intake guide while intake runs. It opens the message list, so it caches with the history
 * that follows it. Every ID it shows joins the allow-list.
 */
export async function buildSessionBlock(
  data: GmData,
  session: GmSession,
  user: GmUser | null,
  prompts: GmPrompts,
): Promise<string> {
  const userId = session.userId;
  const [facts, shelf, asks] = await Promise.all([
    data.listAlwaysOnFacts(userId),
    data.listShelfItems(userId),
    data.listActiveAsks(userId),
  ]);
  const shown = shelf.slice(0, SHELF_LINES);
  session.allow.remember(shown.map((i) => i.id));
  session.allow.remember(asks.map((a) => a.id));

  const lines = ["<session>"];
  lines.push(`First name: ${user?.firstName ? clean(user.firstName, 40) : "unknown"}`);
  lines.push(`Conversation mode: ${session.mode}`);
  lines.push(
    facts.length
      ? `What they've told you before (always-on facts):\n${facts.map((f) => `- ${f.category}/${clean(f.key, 40)}: ${clean(f.value, 200)}`).join("\n")}`
      : "What they've told you before: nothing yet.",
  );
  lines.push(
    shelf.length
      ? `Their Shelf (${shelf.length} Item${shelf.length === 1 ? "" : "s"}${shelf.length > SHELF_LINES ? `, newest ${SHELF_LINES} shown; search_my_shelf finds the rest` : ""}):\n${shown.map((i) => ownItemText(i)).join("\n")}`
      : "Their Shelf: empty.",
  );
  lines.push(
    asks.length
      ? `Their open Asks:\n${asks.map((a) => `- ask_id: ${a.id}, ${clean(askTitle(a) ?? a.rawText, 80)}, status ${a.status}`).join("\n")}`
      : "Their open Asks: none.",
  );
  lines.push("</session>");
  const intake = prompts.skills.get("intake");
  if (session.mode === "intake" && intake) {
    lines.push(`<intake_guide>\n${intake.body}\n</intake_guide>`);
  }
  const block = lines.join("\n");
  for (const a of dollarAmounts(block)) session.amounts.add(a);
  return block;
}

/** The volatile block: placed after the rolling breakpoint so it never breaks the cache. */
export function volatileBlock(now: Date, screen: string | undefined): string {
  const parts = [`<now>${now.toISOString().slice(0, 16).replace("T", " ")} UTC</now>`];
  if (screen) parts.push(`<screen>${clean(screen, 120)}</screen>`);
  return parts.join("\n");
}

function withCache(blocks: Anthropic.ContentBlockParam[]): Anthropic.ContentBlockParam[] {
  const copy = blocks.map((b) => ({ ...b }));
  const last = copy[copy.length - 1];
  if (last) (last as { cache_control?: unknown }).cache_control = EPHEMERAL;
  return copy;
}

export interface RequestParts {
  model: string;
  maxTokens: number;
  system: string;
  tools: Anthropic.Tool[];
  sessionBlock: string;
  /** Earlier turns, API-native. */
  history: Anthropic.MessageParam[];
  /** This turn's user content, as stored. */
  current: Anthropic.ContentBlockParam[];
  volatile: string;
  /** This turn's assistant and tool-result messages so far. */
  steps: Anthropic.MessageParam[];
}

/**
 * Orders a request from most to least stable, for the prompt cache:
 * 1. Global: tool definitions and the system prompt, breakpoint at the end of the system.
 * 2. Session: the session block, history, then this turn's user content with a rolling
 *    breakpoint on its last block (and on the latest tool results within the turn).
 * 3. Volatile: time and screen, after the breakpoint.
 */
export function buildRequest(p: RequestParts): CreateParams {
  const steps = p.steps.map((m, i) => {
    const isLatestResults = i === p.steps.length - 1 && m.role === "user";
    return isLatestResults
      ? { role: m.role, content: withCache(m.content as Anthropic.ContentBlockParam[]) }
      : m;
  });
  const messages = mergeRoles([
    { role: "user", content: [{ type: "text", text: p.sessionBlock }] },
    ...p.history,
    {
      role: "user",
      content: [...withCache(p.current), { type: "text", text: p.volatile }],
    },
    ...steps,
  ]);
  return {
    model: p.model,
    max_tokens: p.maxTokens,
    system: [{ type: "text", text: p.system, cache_control: EPHEMERAL }],
    tools: p.tools,
    messages,
  };
}
