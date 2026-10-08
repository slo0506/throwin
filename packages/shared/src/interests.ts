import { z } from "zod";
import { DealItem } from "./deals.js";

// "Someone wants your Item" (docs/contracts/m3-matcher.md, "Interests"): a Circle-mate's Ask
// matches an Item on the user's Shelf that they offer for nothing. They see what the asker
// offers for that Ask and pick 1 thing they'd take, or say no.

export const Interest = z.object({
  id: z.uuid(),
  /** Who's looking. First name only. */
  wanter_first_name: z.string().nullable(),
  /** What they asked for, in their Ask's title. */
  ask_title: z.string(),
  /** The user's own Item. */
  item: DealItem,
  /** What the asker offers for that Ask: the user may pick 1. Never their cash ceiling. */
  their_offer: z.array(DealItem),
  expires_at: z.iso.datetime({ offset: true }),
});
export type Interest = z.infer<typeof Interest>;

export const InterestsResponse = z.object({ interests: z.array(Interest) });
export type InterestsResponse = z.infer<typeof InterestsResponse>;

/** Yes names the Item the user would take; no takes nothing. */
export const InterestAnswer = z.discriminatedUnion("answer", [
  z.strictObject({ answer: z.literal("yes"), want_item_id: z.uuid() }),
  z.strictObject({ answer: z.literal("no") }),
]);
export type InterestAnswer = z.infer<typeof InterestAnswer>;
