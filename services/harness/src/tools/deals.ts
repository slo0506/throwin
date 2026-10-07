import {
  type CounterCardData,
  type DealItem,
  type DealPerson,
  type DealSheet,
  fenceUntrusted,
  MAX_COUNTER_CHANGES,
} from "@throwin/shared";
import { z } from "zod";
import { usd, usdRange } from "../format.js";
import { assertIssued, defineTool, type ToolContext, ToolError } from "./registry.js";
import { shownNote } from "./render.js";

// Deals and counters (docs/contracts/m3-deals.md, "Counters"). The GM reads Deals from the
// user's side and stages counters as cards. Only the user's tap sends a counter, and
// nothing here approves, declines or answers one.

function desk(ctx: ToolContext) {
  if (!ctx.deals)
    throw new ToolError("unavailable", "Deals and counters aren't available right now.");
  return ctx.deals;
}

const who = (p: DealPerson) =>
  fenceUntrusted("first_name", p.first_name ?? "someone", { maxLength: 40 });

const itemLines = (items: DealItem[]) =>
  items
    .map(
      (i) =>
        `    - ${i.id}:\n${fenceUntrusted("item_title", i.title, { maxLength: 120 })}\n      value: ${i.value ? usdRange(i.value.low_cents, i.value.high_cents) : "not priced"}`,
    )
    .join("\n");

const cashText = (c: { pay_cents: number; receive_cents: number }) =>
  c.pay_cents > 0
    ? `the user adds ${usd(c.pay_cents)}`
    : c.receive_cents > 0
      ? `the user gets ${usd(c.receive_cents)}`
      : "no cash";

function statusText(d: DealSheet, userId: string): string {
  const c = d.counter;
  if (c?.your_answer === "pending") return "a counter waits on the user's answer";
  if (c) {
    const mine = c.proposed_by.user_id === userId;
    return `${mine ? "the user's counter" : "a counter"} waits on others to answer`;
  }
  if (d.status !== "pending_approvals") return d.status;
  return d.your_approval === "pending"
    ? "waiting on the user's approval"
    : "the user approved; waiting on others";
}

export function dealText(d: DealSheet, userId: string): string {
  const others = d.participants.filter((p) => p.user_id !== userId);
  const lines = [
    `- deal_id: ${d.id}`,
    `  status: ${statusText(d, userId)}`,
    `  with ${others.length === 1 ? "1 other person" : `${others.length} others, a Loop`}:\n${others.map(who).join("\n")}`,
    `  the user gives, to the person below:\n${who(d.give_to)}\n${itemLines(d.gives)}`,
    `  the user gets, from the person below:\n${who(d.get_from)}\n${itemLines(d.gets)}`,
    `  cash: ${cashText(d.cash)}`,
    `  counters left: ${d.counters_left}`,
  ];
  const c = d.counter;
  if (c) {
    lines.push(
      `  open counter, proposed by:\n${who(c.proposed_by)}`,
      ...c.changes.map(
        (ch) =>
          `    ${ch.op === "add" ? "adds" : "removes"} ${ch.item.id}, given by the person below:\n${who(ch.giver)}\n${fenceUntrusted("item_title", ch.item.title, { maxLength: 120 })}`,
      ),
      `    the user's side would be: gives ${c.gives.length}, gets ${c.gets.length}, ${cashText(c.cash)}`,
    );
  }
  return lines.join("\n");
}

export const getDeals = defineTool({
  name: "get_deals",
  description:
    "The user's open Deals from their side: what they give and get, the cash, who's in it, counters left and any open counter. Read it before talking about a Deal or staging a counter.",
  kind: "read",
  input: z.object({}),
  progress: () => "Checking your deals",
  async run(ctx) {
    const deals = await desk(ctx).list(ctx.userId);
    if (deals.length === 0) return { content: "The user has no open Deals." };
    return {
      content: `${deals.length} open Deal${deals.length === 1 ? "" : "s"}:\n${deals.map((d) => dealText(d, ctx.userId)).join("\n")}`,
      issuedIds: deals.flatMap((d) => [
        d.id,
        ...d.gives.map((i) => i.id),
        ...d.gets.map((i) => i.id),
        ...(d.counter?.changes.map((ch) => ch.item.id) ?? []),
      ]),
    };
  },
});

function cardText(card: CounterCardData): string {
  const lines = card.lines.map(
    (l) =>
      `${l.op === "add" ? "adds" : "takes out"} ${l.item.id}, from the person below to the next:\n${who(l.giver)}\n${who(l.receiver)}`,
  );
  return [
    ...lines,
    `Cash: ${cashText(card.cash)}, instead of: ${cashText(card.cash_now)}.`,
    `Waiting on ${card.waiting_on.length === 1 ? "this person" : "these people"} to accept:\n${card.waiting_on.map(who).join("\n")}`,
  ].join("\n");
}

export const stageCounter = defineTool({
  name: "stage_counter",
  description:
    "Turn what the user wants changed in a Deal into a counter card: up to 3 changes, each adding 1 Item (the other side's, or the user's own as a sweetener) or taking 1 out. The server checks it and works out the cash. It goes out only when the user taps Send on the card.",
  kind: "render",
  input: z.object({
    deal_id: z.string().describe("From get_deals"),
    changes: z
      .array(
        z.object({
          op: z.enum(["add", "remove"]),
          item_id: z.string().describe("From get_deals, search_network or search_my_shelf"),
        }),
      )
      .min(1)
      .max(MAX_COUNTER_CHANGES),
  }),
  progress: () => "Working out the counter",
  async run(ctx, input) {
    assertIssued(ctx, input.deal_id, ...input.changes.map((c) => c.item_id));
    const result = await desk(ctx).preview(ctx.userId, input.deal_id, input.changes);
    if ("problem" in result) throw new ToolError(result.problem, result.message);
    const id = ctx.newId();
    return {
      content: `${shownNote("counter_card", id)}\n${cardText(result)}\nIt goes out only if the user taps Send. You can't send it for them.`,
      component: { id, kind: "counter_card", data: result },
    };
  },
});
