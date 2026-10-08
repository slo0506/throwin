import { z } from "zod";

// Home's "Next up": what needs the user, across Deals, the Shelf and Asks, best first.
// Computed on the server so the same list can drive notifications and the GM's check-ins.

export const NextUpKind = z.enum([
  /** Someone countered a Deal and is waiting on the user's answer. */
  "answer_counter",
  /** A Deal Sheet waiting on the user's approval. */
  "approve_deal",
  /** A staged Deal is waiting for showcase photos of the user's Item. */
  "showcase_photos",
  /** Would an Item close to what the user asked for work? 1 tap. */
  "answer_inquiry",
  /** A Circle-mate wants an Item the user offers for nothing: see what they'd trade. */
  "someone_wants",
  /** An Ask with nothing offered yet: the GM can't look until there is. */
  "offer_for_ask",
  /** Open Asks, but no Circle to trade in. */
  "join_circle",
  /** An Ask whose best offer falls well short of what it goes for. */
  "weak_offer",
  /** People in the user's Circles want something 1 of their Items could fill. */
  "in_demand",
  /** Open Tune up questions across the Shelf. */
  "tune_up",
  /** An identified Item a few photos away from ready to show. */
  "item_photos",
  /** An empty Shelf. */
  "add_to_shelf",
  /** No Asks yet. */
  "new_ask",
]);
export type NextUpKind = z.infer<typeof NextUpKind>;

export const NextUpItem = z.object({
  /** Stable across refreshes, e.g. "deal:<id>", so the app can animate changes. */
  id: z.string(),
  kind: NextUpKind,
  title: z.string(),
  detail: z.string(),
  /** The button's words, e.g. "Review". */
  cta: z.string(),
  deal_id: z.uuid().nullable(),
  ask_id: z.uuid().nullable(),
  item_id: z.uuid().nullable(),
  /** The angles to shoot, for showcase_photos and item_photos. */
  angles: z.array(z.string()),
  thumbnail_url: z.string().nullable(),
  /** When the chance goes away, for Deals. */
  expires_at: z.iso.datetime({ offset: true }).nullable(),
});
export type NextUpItem = z.infer<typeof NextUpItem>;

export const NextUpResponse = z.object({ items: z.array(NextUpItem) });
export type NextUpResponse = z.infer<typeof NextUpResponse>;
