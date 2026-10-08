import { z } from "zod";
import { ValueRange } from "./api.js";
import { ConditionGrade, DealStatus } from "./enums.js";

// Deal Sheets (Milestone 3). Shapes are fixed by docs/contracts/m3-deals.md.

export const ApprovalState = z.enum(["pending", "approved", "declined"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

/** First name and photo only, the same as a Circle roster. */
export const DealPerson = z.object({
  user_id: z.uuid(),
  first_name: z.string().nullable(),
  photo_url: z.string().nullable(),
});
export type DealPerson = z.infer<typeof DealPerson>;

/** Every Item in a Deal is showcase, so its photo is always shown. */
export const DealItem = z.object({
  id: z.uuid(),
  title: z.string(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  condition_grade: ConditionGrade.nullable(),
  value: ValueRange.nullable(),
  photo_url: z.string().nullable(),
});
export type DealItem = z.infer<typeof DealItem>;

/** Counters a Deal can have, in all, and changes in 1 counter. */
export const MAX_COUNTER_ROUNDS = 3;
export const MAX_COUNTER_CHANGES = 3;

/**
 * 1 change in a counter: hand over 1 more Item, or take 1 out. An added Item goes from its
 * owner to the person they give to in the Deal. Structured only, never free text.
 */
export const CounterChange = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), item_id: z.uuid() }),
  z.strictObject({ op: z.literal("remove"), item_id: z.uuid() }),
]);
export type CounterChange = z.infer<typeof CounterChange>;

export const CounterCreate = z.strictObject({
  changes: z.array(CounterChange).min(1).max(MAX_COUNTER_CHANGES),
});
export type CounterCreate = z.infer<typeof CounterCreate>;

const Cash = z.object({
  pay_cents: z.number().int().nonnegative(),
  receive_cents: z.number().int().nonnegative(),
});

/** An open counter on a Deal, from the caller's side. */
export const DealCounter = z.object({
  id: z.uuid(),
  proposed_by: DealPerson,
  /** What it changes, Item by Item. */
  changes: z.array(
    z.object({
      op: z.enum(["add", "remove"]),
      item: DealItem,
      giver: DealPerson,
      receiver: DealPerson,
    }),
  ),
  /** The caller's side as it would be. */
  gives: z.array(DealItem),
  gets: z.array(DealItem),
  cash: Cash,
  fairness: z.object({
    give_cents: z.number().int().nonnegative(),
    get_cents: z.number().int().nonnegative(),
  }),
  /** The caller's answer so far, or null when the counter doesn't ask them. */
  your_answer: z.enum(["pending", "accepted", "declined"]).nullable(),
  /** People who still have to answer. */
  waiting_on: z.array(DealPerson),
  expires_at: z.iso.datetime({ offset: true }),
});
export type DealCounter = z.infer<typeof DealCounter>;

export const DealSheet = z.object({
  id: z.uuid(),
  status: DealStatus,
  expires_at: z.iso.datetime({ offset: true }),
  /**
   * The caller's side: what leaves their Shelf and what comes to them. Several Items on a
   * side is a bundle; `gets` starts with the Items for the Ask the Deal fills.
   */
  gives: z.array(DealItem).min(1),
  give_to: DealPerson,
  gets: z.array(DealItem).min(1),
  get_from: DealPerson,
  /** The first of `gives` and `gets`, for app builds from before bundles. */
  you_give: DealItem,
  you_get: DealItem,
  /** Cash Throw-Ins the caller pays or receives, in total. */
  cash: Cash,
  /** "You give about $X in value and get about $Y": each side's mid values, summed. */
  fairness: z.object({
    give_cents: z.number().int().nonnegative(),
    get_cents: z.number().int().nonnegative(),
  }),
  /** Every leg of the Loop, so all participants see the same Items and ranges. */
  loop: z.array(z.object({ giver: DealPerson, receiver: DealPerson, item: DealItem })),
  throw_ins: z.array(
    z.object({ payer: DealPerson, payee: DealPerson, amount_cents: z.number().int().positive() }),
  ),
  participants: z.array(DealPerson.extend({ approval: ApprovalState })),
  your_approval: ApprovalState,
  /** Why the GM likes it, from the user's side. Null until the Prospector's review writes it. */
  why: z.string().nullable(),
  /**
   * The caller's own Ask this Deal fills: the 1 they give for. A bundle can fill more of
   * their Asks too. Null for a Drop leg that isn't tied to an Ask.
   */
  your_ask_id: z.uuid().nullable(),
  /** An open counter. While it's open, nobody can approve. */
  counter: DealCounter.nullable(),
  /** How many more counters this Deal can have. */
  counters_left: z.number().int().min(0).max(MAX_COUNTER_ROUNDS),
  /** Set when an accepted counter replaced this Deal: the version to show instead. */
  superseded_by: z.uuid().nullable(),
});
export type DealSheet = z.infer<typeof DealSheet>;

export const DealSheetsResponse = z.object({ deals: z.array(DealSheet) });
export type DealSheetsResponse = z.infer<typeof DealSheetsResponse>;

export const DealDecline = z.strictObject({
  reason: z.string().trim().max(200).optional(),
});
export type DealDecline = z.infer<typeof DealDecline>;
