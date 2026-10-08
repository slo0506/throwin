import { AutonomyLevel, cantTrade, fenceUntrusted, MAX_ASK_ITEMS } from "@throwin/shared";
import { z } from "zod";
import type { AskPatch, AskRecord, AskTarget } from "../data.js";
import { askTitle, clean, offerValue, statusLine, usd, usdRange } from "../format.js";
import type { ResolvedTargetData } from "../history.js";
import { assertIssued, defineTool, type ToolContext, ToolError } from "./registry.js";
import { askText } from "./text.js";

export const MAX_CASH_CEILING_CENTS = 100_000;

/** The Ask as the model reads it, with the server's status line and offer value. */
export async function describeAsk(ctx: ToolContext, ask: AskRecord) {
  const [items, stats] = await Promise.all([
    ctx.data.getOwnItems(ctx.userId, ask.offerItemIds),
    ctx.data.circleStats(ctx.userId),
  ]);
  return askText(ask, statusLine(ask, stats), offerValue(items));
}

async function ownAsk(ctx: ToolContext, askId: string) {
  assertIssued(ctx, askId);
  const ask = await ctx.data.getAsk(ctx.userId, askId);
  if (!ask) throw new ToolError("not_found", "That Ask does not exist or is not the user's.");
  return ask;
}

/** Writes through public.patch_ask, the same path as PATCH /v1/asks/{id}. */
async function patchAsk(ctx: ToolContext, askId: string, patch: AskPatch): Promise<AskRecord> {
  const result = await ctx.data.updateAsk(ctx.userId, askId, patch);
  if (result === "not_found")
    throw new ToolError("not_found", "That Ask does not exist or is not the user's.");
  if (result === "ask_closed")
    throw new ToolError("ask_locked", "This Ask is closed and can't be edited in chat.");
  if (result === "invalid_offer_item")
    throw new ToolError(
      "item_not_offerable",
      "An Item is no longer the user's, on the Shelf and free. Check the Shelf again.",
    );
  return result;
}

function targetText(id: string, t: ResolvedTargetData) {
  const lines = [
    `target_id: ${id}`,
    `kind: ${t.kind}`,
    `name:\n${fenceUntrusted("product_research", t.name, { maxLength: 120 })}`,
    `brand: ${t.brand ? clean(t.brand, 60) : "unknown"}, model: ${t.model ? clean(t.model, 60) : "unknown"}, category: ${t.category ?? "unknown"}`,
    t.anchor
      ? `price anchor: ${t.anchor.retail_cents !== null ? `retail ${usd(t.anchor.retail_cents)}, ` : "retail unknown, "}used ${usdRange(t.anchor.used_low_cents, t.anchor.used_high_cents)}`
      : "price anchor: none found. Do not quote a price.",
    `confidence: ${t.confidence.toFixed(2)}`,
  ];
  if (t.constraints.length)
    lines.push(`constraints: ${t.constraints.map((c) => clean(c, 80)).join("; ")}`);
  if (t.alternatives.length) {
    lines.push(
      `other products that fit:\n${fenceUntrusted(
        "product_research",
        t.alternatives.map((a, i) => `${i + 1}. ${a.name}: ${a.detail}`).join("\n"),
        { maxLength: 600 },
      )}`,
    );
  }
  lines.push(
    t.confidence < 0.6 || t.alternatives.length
      ? "If you are not sure this is what they mean, ask 1 question (present_choices) before upsert_ask."
      : "Save it with upsert_ask using this target_id.",
  );
  return lines.join("\n");
}

export const resolveTarget = defineTool({
  name: "resolve_target",
  description:
    "Identify the exact product the user wants from their words, a photo they sent (image_path) or a link, with a price anchor (retail and typical used range). Call it before upsert_ask.",
  kind: "read",
  input: z
    .object({
      text: z.string().max(500).optional().describe("The want in the user's words"),
      url: z.string().max(500).optional(),
      image_path: z.string().max(300).optional().describe("A photo path the user attached"),
    })
    .refine((v) => v.text || v.url || v.image_path, { message: "Give text, url or image_path" }),
  progress: () => "Looking it up",
  async run(ctx, input) {
    let image: Awaited<ReturnType<typeof ctx.data.loadImage>> = null;
    if (input.image_path) {
      assertIssued(ctx, input.image_path);
      image = await ctx.data.loadImage(ctx.userId, input.image_path);
      if (!image) throw new ToolError("not_found", "That photo could not be loaded.");
    }
    if (input.url && !/^https?:\/\//i.test(input.url)) {
      throw new ToolError("invalid_input", "url must start with http:// or https://");
    }
    const target = await ctx.resolver.resolve(
      { text: input.text, url: input.url, image: image ?? undefined },
      (run) => ctx.recordModelRun("resolve_target", run),
    );
    if (target.prohibited_reason) {
      // No target_id: there is nothing to make an Ask from.
      return {
        content: `${cantTrade(target.prohibited_reason)} Tell the user that in 1 plain sentence, without lecturing. Don't make an Ask for it and don't suggest a workaround.`,
      };
    }
    const targetId = ctx.newId();
    return { content: targetText(targetId, target), target: { target_id: targetId, data: target } };
  },
});

const toAskTarget = (t: ResolvedTargetData, constraints?: string[]): AskTarget => ({
  kind: t.kind,
  name: t.name,
  brand: t.brand,
  model: t.model,
  category: t.category,
  constraints: constraints ?? t.constraints,
  anchor: t.anchor,
  image_url: t.image_url,
});

export const upsertAsk = defineTool({
  name: "upsert_ask",
  description:
    "Create the user's Ask, or edit 1 they own (pass ask_id). The target and its price anchor come only from a resolve_target result, by target_id.",
  kind: "write",
  input: z.object({
    ask_id: z.string().optional().describe("Omit to create a new Ask"),
    raw_text: z.string().trim().min(1).max(500).optional().describe("The want in the user's words"),
    target_id: z.string().optional().describe("From resolve_target"),
    constraints: z
      .array(z.string().trim().min(1).max(80))
      .max(5)
      .optional()
      .describe("The user's own conditions, e.g. 'built is fine'"),
    deadline: z.iso.date().optional().describe("YYYY-MM-DD, only if the user gave one"),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(MAX_ASK_ITEMS)
      .optional()
      .describe(
        "How many Items they'd take, only when they want several ('2 or 3 board games', 'any Switch games'). Omit for 1.",
      ),
  }),
  progress: (input) => (input.ask_id ? "Updating your Ask" : "Saving your Ask"),
  async run(ctx, input) {
    let target: ResolvedTargetData | undefined;
    if (input.target_id) {
      assertIssued(ctx, input.target_id);
      target = ctx.session.targets.get(input.target_id);
      if (!target)
        throw new ToolError("unknown_id", "That target_id is not a resolve_target result.");
      if (target.prohibited_reason)
        throw new ToolError("prohibited", cantTrade(target.prohibited_reason));
    }
    const deadline = input.deadline ? new Date(`${input.deadline}T23:59:59Z`) : undefined;
    if (deadline && deadline.getTime() <= ctx.now().getTime()) {
      throw new ToolError("invalid_input", "The deadline must be in the future.");
    }

    if (!input.ask_id) {
      if (!input.raw_text)
        throw new ToolError("invalid_input", "raw_text is required to create an Ask.");
      const ask = await ctx.data.createAsk(ctx.userId, {
        rawText: input.raw_text,
        title: target?.name ?? null,
        target: target ? toAskTarget(target, input.constraints) : null,
        status: target ? "offering" : "drafting",
        maxItems: input.max_items ?? 1,
        // Which deals to bring is 1 profile setting for every Ask (set_autonomy).
        autonomy: (await ctx.data.getUser(ctx.userId))?.autonomy ?? "every_deal",
        deadline: deadline ?? null,
      });
      const title = clean(askTitle(ask) ?? ask.rawText, 80);
      return {
        content: `Created the Ask.\n${await describeAsk(ctx, ask)}\nNext: ask what they would offer, then set_offer_set.`,
        issuedIds: [ask.id],
        askId: ask.id,
        summary: `Made your Ask: ${title}`,
      };
    }

    const current = await ownAsk(ctx, input.ask_id);
    if (!["drafting", "offering", "prospecting"].includes(current.status)) {
      throw new ToolError(
        "ask_locked",
        `This Ask is ${current.status} and can't be edited in chat.`,
      );
    }
    const nextTarget = target
      ? toAskTarget(target, input.constraints)
      : current.target && input.constraints
        ? { ...current.target, constraints: input.constraints }
        : undefined;
    const ask = await patchAsk(ctx, current.id, {
      ...(input.raw_text && { rawText: input.raw_text }),
      ...(nextTarget && { target: nextTarget }),
      ...(target && { title: target.name }),
      ...(deadline && { deadline }),
      ...(input.max_items !== undefined && { maxItems: input.max_items }),
    });
    return {
      content: `Updated the Ask.\n${await describeAsk(ctx, ask)}`,
      issuedIds: [ask.id],
      askId: ask.id,
      summary: `Updated your Ask: ${clean(askTitle(ask) ?? ask.rawText, 80)}`,
    };
  },
});

export const setOfferSet = defineTool({
  name: "set_offer_set",
  description:
    "Choose which of the user's own Shelf Items an Ask may use, and the most cash they would add (a Throw-In). Replaces the previous offer set.",
  kind: "write",
  input: z.object({
    ask_id: z.string(),
    item_ids: z.array(z.string()).max(20).describe("The user's own on-Shelf Item IDs"),
    cash_ceiling_cents: z
      .number()
      .int()
      .min(0)
      .max(MAX_CASH_CEILING_CENTS)
      .describe("Most cash they would add, in cents (0 to 100000)"),
  }),
  progress: () => "Saving your offer",
  async run(ctx, input) {
    const ask = await ownAsk(ctx, input.ask_id);
    const ids = [...new Set(input.item_ids)];
    assertIssued(ctx, ...ids);
    if (!["drafting", "offering", "prospecting"].includes(ask.status)) {
      throw new ToolError(
        "ask_locked",
        `This Ask is ${ask.status}; its offer can't change in chat.`,
      );
    }
    const items = await ctx.data.getOwnItems(ctx.userId, ids);
    const byId = new Map(items.map((i) => [i.id, i]));
    const problems: string[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) problems.push(`${id} is not on the user's Shelf`);
      else if (item.status !== "on_shelf" || item.reserved)
        problems.push(
          `${clean(item.title, 60)} is ${item.reserved ? "held by a Deal" : "not on the Shelf yet"}`,
        );
      else if (item.willingness === "not_available")
        problems.push(`${clean(item.title, 60)} is marked not available`);
    }
    if (problems.length)
      throw new ToolError("item_not_offerable", `Can't offer: ${problems.join("; ")}.`);

    const final = await patchAsk(ctx, ask.id, {
      offerItemIds: ids,
      cashCeilingCents: input.cash_ceiling_cents,
    });
    const title = clean(askTitle(final) ?? final.rawText, 80);
    const cash =
      input.cash_ceiling_cents > 0 ? `up to ${usd(input.cash_ceiling_cents)} cash` : "no cash";
    return {
      content: `Saved the offer.\n${await describeAsk(ctx, final)}`,
      issuedIds: [final.id],
      askId: final.id,
      summary: `Set your offer for ${title}: ${ids.length} Item${ids.length === 1 ? "" : "s"}, ${cash}`,
    };
  },
});

const AUTONOMY_WORDS: Record<AutonomyLevel, string> = {
  every_deal: "every deal",
  likely_yes: "only deals they'd likely say yes to",
};

export const setAutonomy = defineTool({
  name: "set_autonomy",
  description:
    "Save which deals to bring the user: every_deal (every deal you find) or likely_yes (only deals they'd likely accept). It's 1 setting for all their Asks, now and later, and they can change it in Settings. Never ask it per Ask.",
  kind: "write",
  input: z.object({ level: AutonomyLevel }),
  progress: null,
  async run(ctx, input) {
    await ctx.data.setAutonomy(ctx.userId, input.level);
    return {
      content: `Saved: bring them ${AUTONOMY_WORDS[input.level]}. This applies to every Ask; they can change it in Settings.`,
      summary:
        input.level === "every_deal"
          ? "Set to bring you every deal"
          : "Set to bring you only likely yeses",
    };
  },
});

export const getAskStatus = defineTool({
  name: "get_ask_status",
  description: "Current status, offer and prospecting progress of 1 of the user's Asks.",
  kind: "read",
  input: z.object({ ask_id: z.string() }),
  progress: () => "Checking on your Ask",
  async run(ctx, input) {
    const ask = await ownAsk(ctx, input.ask_id);
    return { content: `${await describeAsk(ctx, ask)}\n  candidate deals: none yet` };
  },
});
