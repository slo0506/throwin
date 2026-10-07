import { z } from "zod";

// Demand counts (decided Oct 7, 2026): what people in the user's Circles are looking for,
// as counts only. Never who, never their Ask, never their limits.

export const DemandEntry = z.object({
  /** The want, as resolved: "Nintendo Switch game". Written from other people's words. */
  label: z.string(),
  category: z.string().nullable(),
  /** How many people want it: 2 or more, unless the user has an Item that could fill it. */
  askers: z.number().int().positive(),
  /** The user's own Items that could fill it. */
  your_item_ids: z.array(z.uuid()),
});
export type DemandEntry = z.infer<typeof DemandEntry>;

export const DemandResponse = z.object({ demand: z.array(DemandEntry) });
export type DemandResponse = z.infer<typeof DemandResponse>;
