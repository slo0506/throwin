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
  cash: z.object({
    pay_cents: z.number().int().nonnegative(),
    receive_cents: z.number().int().nonnegative(),
  }),
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
});
export type DealSheet = z.infer<typeof DealSheet>;

export const DealSheetsResponse = z.object({ deals: z.array(DealSheet) });
export type DealSheetsResponse = z.infer<typeof DealSheetsResponse>;

export const DealDecline = z.strictObject({
  reason: z.string().trim().max(200).optional(),
});
export type DealDecline = z.infer<typeof DealDecline>;
