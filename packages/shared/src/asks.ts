import { z } from "zod";
import { AskStatus, AutonomyLevel } from "./enums.js";

// Asks and taste facts (Milestone 2). Shapes are fixed by docs/contracts/m2-gm-and-asks.md.

const cents = z.number().int().nonnegative();

/** Retail price plus the typical used range, so the Ask card can show a price anchor. */
export const AskAnchor = z
  .strictObject({
    retail_cents: cents.nullable().default(null),
    used_low_cents: cents,
    used_high_cents: cents,
  })
  .refine((a) => a.used_low_cents <= a.used_high_cents, {
    message: "Expected used_low_cents <= used_high_cents",
    path: ["used_low_cents"],
  });
export type AskAnchor = z.infer<typeof AskAnchor>;

/** What the Ask resolved to: an exact product, or a category with constraints. */
export const AskTarget = z.strictObject({
  kind: z.enum(["exact", "category"]),
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(80).nullable().default(null),
  model: z.string().trim().min(1).max(80).nullable().default(null),
  category: z.string().trim().min(1).max(80).nullable().default(null),
  constraints: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  anchor: AskAnchor.nullable().default(null),
});
export type AskTarget = z.infer<typeof AskTarget>;

/** The low and high of the offer Items' value ranges, summed. Zeros when nothing is offered. */
export const OfferValue = z
  .object({ low_cents: cents, high_cents: cents })
  .refine((v) => v.low_cents <= v.high_cents, { message: "Expected low_cents <= high_cents" });
export type OfferValue = z.infer<typeof OfferValue>;

export const CASH_CEILING_MAX_CENTS = 100_000;
const cashCeiling = z.number().int().min(0).max(CASH_CEILING_MAX_CENTS);

/** Items in 1 offer set, at most. */
export const MAX_OFFER_ITEMS = 20;

export const Ask = z.object({
  id: z.uuid(),
  raw_text: z.string(),
  /** Set from the resolved target. Null while the Ask is still drafting. */
  title: z.string().max(120).nullable(),
  status: AskStatus,
  /** Plain words computed by the server, e.g. "Waiting for what you'd offer". */
  status_line: z.string(),
  /** Null until the GM resolves what the user wants. */
  target: AskTarget.nullable(),
  offer_item_ids: z.array(z.uuid()),
  offer_value: OfferValue,
  /** The owner's max cash Throw-In. Only ever returned to the Ask's owner. */
  cash_ceiling_cents: cashCeiling,
  autonomy: AutonomyLevel,
  deadline: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type Ask = z.infer<typeof Ask>;

export const AsksResponse = z.object({ asks: z.array(Ask) });
export type AsksResponse = z.infer<typeof AsksResponse>;

export const AskCreate = z.strictObject({
  raw_text: z.string().trim().min(1).max(500),
  target: AskTarget.optional(),
  cash_ceiling_cents: cashCeiling.optional(),
  autonomy: AutonomyLevel.optional(),
});
export type AskCreate = z.infer<typeof AskCreate>;

export const AskPatch = z
  .strictObject({
    raw_text: z.string().trim().min(1).max(500),
    target: AskTarget,
    /** Replaces the offer set. Each must be the owner's own Item, on the Shelf, not reserved. */
    offer_item_ids: z
      .array(z.uuid())
      .max(MAX_OFFER_ITEMS)
      .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
    cash_ceiling_cents: cashCeiling,
    autonomy: AutonomyLevel,
    deadline: z.iso.datetime({ offset: true }).nullable(),
    /** The only status a client may set. */
    status: z.literal("cancelled"),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least 1 field is required" });
export type AskPatch = z.infer<typeof AskPatch>;

/** Statuses after which an Ask no longer changes. */
export const CLOSED_ASK_STATUSES: readonly AskStatus[] = ["fulfilled", "expired", "cancelled"];

/**
 * The Ask card's status line, in plain words, from the status and how many Items are
 * offered. Later milestones may pass richer prospecting progress ("Checking 46 Shelves").
 */
export function askStatusLine(status: AskStatus, offerCount: number): string {
  switch (status) {
    case "drafting":
      return "Pinning down what you want";
    case "offering":
      return "Waiting for what you'd offer";
    case "prospecting":
      return offerCount > 0
        ? "Looking through your Circles"
        : "Add something to offer and I'll keep looking";
    case "proposed":
      return "A deal is ready for you to look at";
    case "accepted":
      return "Deal accepted, setting up the handoff";
    case "fulfilled":
      return "Done, you got it";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
  }
}

// ---------------------------------------------------------------------------
// Taste facts: typed preferences the GM learned. User-visible and deletable.
// ---------------------------------------------------------------------------

/** limits is the never-trade list; preferences holds the handoff spot and autonomy. */
export const TasteFactCategory = z.enum(["interests", "hunting", "limits", "preferences", "style"]);
export type TasteFactCategory = z.infer<typeof TasteFactCategory>;

/** Where a fact came from, as stored. The API shows it as a human label. */
export const TasteFactSource = z.enum(["intake", "chat", "shelf_edits"]);
export type TasteFactSource = z.infer<typeof TasteFactSource>;

export const TASTE_FACT_SOURCE_LABELS: Record<TasteFactSource, string> = {
  intake: "Intake chat",
  chat: "Chat",
  shelf_edits: "Shelf edits",
};

/** Active facts per user, at most. */
export const MAX_ACTIVE_TASTE_FACTS = 40;
export const MAX_TASTE_FACT_VALUE = 400;
/** snake_case, starting with a letter. */
export const TASTE_FACT_KEY = /^[a-z][a-z0-9_]{0,79}$/;

export const TasteFact = z.object({
  id: z.uuid(),
  key: z.string().regex(TASTE_FACT_KEY),
  value: z.string().min(1).max(MAX_TASTE_FACT_VALUE),
  category: TasteFactCategory,
  /** Human label, e.g. "Intake chat", "Chat", "Shelf edits". */
  source: z.string(),
  always_on: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
});
export type TasteFact = z.infer<typeof TasteFact>;

export const TasteFactsResponse = z.object({ facts: z.array(TasteFact) });
export type TasteFactsResponse = z.infer<typeof TasteFactsResponse>;
