import {
  type ChoicesData,
  type GmComponent,
  type ItemCardsData,
  type NetworkItemCard,
  RecapData,
  type ShelfItem,
} from "@throwin/shared";
import { z } from "zod";
import type { GmData } from "../data.js";
import { clean, dollarAmounts, toAskCard, toNetworkCard, toShelfItem } from "../format.js";
import { RECAP_OPTIONS } from "../session.js";
import { assertIssued, defineTool, type ToolContext, ToolError } from "./registry.js";

// UI components are tools. The model passes IDs and short words; the server fills every
// price, grade and photo, so a card can never show a number the model made up.

export interface RenderScope {
  userId: string;
  data: GmData;
}

/** Item cards in the order asked. Own Items render in full; others only while showcase. */
export async function renderItemCards(
  scope: RenderScope,
  ids: string[],
  selectable: boolean,
  selectedIds: string[],
): Promise<{ data: ItemCardsData; missing: string[] }> {
  const own = await scope.data.getOwnItems(scope.userId, ids);
  const ownIds = new Set(own.map((i) => i.id));
  const rest = ids.filter((id) => !ownIds.has(id));
  const network = rest.length
    ? await scope.data.listNetworkItems(scope.userId, { ids: rest, limit: rest.length })
    : [];
  const paths = [...own, ...network]
    .map((i) => i.thumbnailPath)
    .filter((p): p is string => p !== null);
  const urls = await scope.data.signedUrls(paths);
  const byId = new Map<string, ShelfItem | NetworkItemCard>();
  for (const i of own) byId.set(i.id, toShelfItem(i, urls));
  for (const i of network) byId.set(i.id, toNetworkCard(i, urls));
  const items = ids.flatMap((id) => byId.get(id) ?? []);
  return {
    data: {
      items,
      selectable,
      selected_ids: selectedIds.filter((id) => byId.has(id)),
    },
    missing: ids.filter((id) => !byId.has(id)),
  };
}

export async function renderAskCard(scope: RenderScope, askId: string) {
  const ask = await scope.data.getAsk(scope.userId, askId);
  if (!ask) return null;
  const [items, stats] = await Promise.all([
    scope.data.getOwnItems(scope.userId, ask.offerItemIds),
    scope.data.circleStats(scope.userId),
  ]);
  return toAskCard(ask, items, stats);
}

const shownNote = (kind: string, id: string) =>
  `Shown to the user as a ${kind} card (component ${id}). Don't repeat its details in text.`;

export const presentItems = defineTool({
  name: "present_items",
  description:
    "Show Items as cards. Set selectable to let the user tap to pick (their pick arrives as their next message). The server fills titles, photos and value ranges.",
  kind: "render",
  input: z.object({
    item_ids: z.array(z.string()).min(1).max(12),
    selectable: z.boolean().default(false),
  }),
  progress: null,
  async run(ctx, input) {
    const ids = [...new Set(input.item_ids)];
    assertIssued(ctx, ...ids);
    const { data, missing } = await renderItemCards(ctx, ids, input.selectable, []);
    if (data.items.length === 0)
      throw new ToolError("not_found", "None of those Items are available.");
    const id = ctx.newId();
    return {
      content: `${shownNote("item_cards", id)}${missing.length ? ` Not shown (no longer available): ${missing.join(", ")}.` : ""}${input.selectable ? " The user can tap to choose." : ""}`,
      component: { id, kind: "item_cards", data },
      ...(input.selectable && { optionIds: data.items.map((i) => i.id) }),
    };
  },
});

const optionId = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/, "Use short lowercase ids like 'tumbler_2022'");

export const presentChoices = defineTool({
  name: "present_choices",
  description:
    "Ask 1 multiple-choice question with 2 to 6 tappable options. The pick arrives as the user's next message.",
  kind: "render",
  input: z.object({
    prompt: z.string().trim().min(1).max(200),
    options: z
      .array(
        z.object({
          id: optionId,
          label: z.string().trim().min(1).max(80),
          detail: z.string().trim().max(160).optional(),
        }),
      )
      .min(2)
      .max(6),
    multiple: z.boolean().default(false),
  }),
  progress: null,
  async run(ctx, input) {
    // 1 question at a time: a second card in the same turn showed up as a duplicate.
    if (ctx.session.choicesThisTurn > 0) {
      throw new ToolError(
        "one_question_per_turn",
        "You already asked a question with present_choices this turn. Stop here and wait for the user's answer.",
      );
    }
    const ids = input.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      throw new ToolError("invalid_input", "Option ids must be unique.");
    ctx.session.choicesThisTurn++;
    const id = ctx.newId();
    const data: ChoicesData = {
      prompt: input.prompt,
      options: input.options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(o.detail && { detail: o.detail }),
      })),
      multiple: input.multiple,
    };
    return {
      content: shownNote("choices", id),
      component: { id, kind: "choices", data },
      optionIds: ids,
    };
  },
});

export const requestMedia = defineTool({
  name: "request_media",
  description:
    "Open the camera with 1 specific instruction, e.g. 'Snap 2 or 3 things you'd trade' or 'Photo of the box's back'. Pass item_id when it is for 1 of their Items.",
  kind: "render",
  input: z.object({
    instruction: z.string().trim().min(1).max(200),
    item_id: z.string().optional(),
  }),
  progress: null,
  async run(ctx, input) {
    if (input.item_id) {
      assertIssued(ctx, input.item_id);
      const [item] = await ctx.data.getOwnItems(ctx.userId, [input.item_id]);
      if (!item) throw new ToolError("not_found", "That Item is not on the user's Shelf.");
    }
    const id = ctx.newId();
    return {
      content: `${shownNote("camera_request", id)} New Items appear on their Shelf about 20 seconds after upload.`,
      component: {
        id,
        kind: "camera_request",
        data: { instruction: input.instruction, ...(input.item_id && { item_id: input.item_id }) },
      },
    };
  },
});

export const presentAsk = defineTool({
  name: "present_ask",
  description: "Show 1 of the user's Asks as a card with its live status, offer and price anchor.",
  kind: "render",
  input: z.object({ ask_id: z.string() }),
  progress: null,
  async run(ctx, input) {
    assertIssued(ctx, input.ask_id);
    const data = await renderAskCard(ctx, input.ask_id);
    if (!data) throw new ToolError("not_found", "That Ask does not exist or is not the user's.");
    const id = ctx.newId();
    return { content: shownNote("ask_card", id), component: { id, kind: "ask_card", data } };
  },
});

/** Dollar amounts in `text` that no tool result in this conversation showed. */
export function ungroundedAmounts(ctx: ToolContext, text: string): number[] {
  return dollarAmounts(text).filter((a) => !ctx.session.amounts.has(a));
}

export const presentRecap = defineTool({
  name: "present_recap",
  description:
    "End of intake: a 1-paragraph recap of what you heard, plus exactly 3 sample decisions grounded in their Shelf and Ask. For give, pass give_item_id of 1 of their Items when you can; the server fills its name.",
  kind: "render",
  input: z.object({
    paragraph: z.string().trim().min(1).max(1200),
    sample_decisions: z
      .array(
        z.object({
          give_item_id: z.string().optional(),
          give: z.string().trim().min(1).max(120).optional(),
          get: z.string().trim().min(1).max(120),
          verdict: z.enum(["yes", "no"]),
          why: z.string().trim().min(1).max(200),
        }),
      )
      .length(3),
  }),
  progress: null,
  async run(ctx, input) {
    const ids = input.sample_decisions.flatMap((d) => (d.give_item_id ? [d.give_item_id] : []));
    assertIssued(ctx, ...ids);
    const items = new Map((await ctx.data.getOwnItems(ctx.userId, ids)).map((i) => [i.id, i]));
    const decisions = input.sample_decisions.map((d) => {
      const item = d.give_item_id ? items.get(d.give_item_id) : undefined;
      if (d.give_item_id && !item)
        throw new ToolError("not_found", `${d.give_item_id} is not on the user's Shelf.`);
      const give = item ? clean(item.title, 120) : d.give;
      if (!give) throw new ToolError("invalid_input", "Each decision needs give_item_id or give.");
      return { give, get: d.get, verdict: d.verdict, why: d.why };
    });
    const words = [input.paragraph, ...decisions.flatMap((d) => [d.give, d.get, d.why])].join("\n");
    const ungrounded = ungroundedAmounts(ctx, words);
    if (ungrounded.length) {
      throw new ToolError(
        "ungrounded_price",
        `The recap mentions ${ungrounded.map((a) => `$${a}`).join(", ")}, which no tool result showed. Remove those amounts or use values from tool results.`,
      );
    }
    const data = RecapData.parse({ paragraph: input.paragraph, sample_decisions: decisions });
    const id = ctx.newId();
    ctx.session.recapShown = true;
    return {
      content: `${shownNote("recap", id)} Ask if anything is off; when they're happy, call finish_intake.`,
      component: { id, kind: "recap", data } satisfies GmComponent,
      optionIds: Object.keys(RECAP_OPTIONS),
    };
  },
});
