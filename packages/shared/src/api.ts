import { z } from "zod";
import { AutonomyLevel, ConditionGrade, ItemStatus, ItemWillingness } from "./enums.js";

// Wire format for the public /v1 API. Keys are snake_case. Money is integer cents.

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const NotificationPrefs = z.object({
  deal_ready: z.boolean(),
  item_wanted: z.boolean(),
  approval_nudge: z.boolean(),
  handoff_reminder: z.boolean(),
  ask_update: z.boolean(),
  /** Promotional pushes need explicit opt-in (App Store 4.5.4). */
  promotional: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  deal_ready: true,
  item_wanted: true,
  approval_nudge: true,
  handoff_reminder: true,
  ask_update: true,
  promotional: false,
};

export const Profile = z.object({
  autonomy_level: AutonomyLevel,
  notification_prefs: NotificationPrefs,
  /** Coarse geohash only, never an address. */
  home_area: z.string().nullable(),
  default_handoff_place_id: z.string().nullable(),
});
export type Profile = z.infer<typeof Profile>;

export const MeCounts = z.object({
  shelf_items: z.number().int().nonnegative(),
  active_asks: z.number().int().nonnegative(),
  circles: z.number().int().nonnegative(),
});
export type MeCounts = z.infer<typeof MeCounts>;

export const Me = z.object({
  id: z.uuid(),
  display_name: z.string().nullable(),
  photo_url: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  profile: Profile,
  counts: MeCounts,
});
export type Me = z.infer<typeof Me>;

export const PatchMe = z
  .strictObject({
    display_name: z.string().trim().min(1).max(50),
    photo_url: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .nullable(),
    autonomy_level: AutonomyLevel,
    notification_prefs: NotificationPrefs.partial().strict(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least 1 field is required" });
export type PatchMe = z.infer<typeof PatchMe>;

export const DeleteMeResponse = z.object({
  status: z.literal("scheduled"),
  hard_delete_after: z.iso.datetime({ offset: true }),
});
export type DeleteMeResponse = z.infer<typeof DeleteMeResponse>;

/** A value estimate. Always a range, never a single number in UI. */
export const ValueRange = z
  .object({
    low_cents: z.number().int().nonnegative(),
    mid_cents: z.number().int().nonnegative(),
    high_cents: z.number().int().nonnegative(),
    currency: z.literal("USD"),
  })
  .refine((v) => v.low_cents <= v.mid_cents && v.mid_cents <= v.high_cents, {
    message: "Expected low <= mid <= high",
  });
export type ValueRange = z.infer<typeof ValueRange>;

export const ShelfItem = z.object({
  id: z.uuid(),
  status: ItemStatus,
  /** Display name, for example "Batmobile Tumbler". */
  title: z.string(),
  willingness: ItemWillingness,
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  variant: z.string().nullable(),
  condition_grade: ConditionGrade.nullable(),
  defects: z.array(z.string()),
  /** Null until the Appraiser has priced the Item. */
  value: ValueRange.nullable(),
  identity_confidence: z.number().min(0).max(1).nullable(),
  condition_confidence: z.number().min(0).max(1).nullable(),
  /** True while a Deal holds this Item. The Deal ID is not exposed here. */
  is_reserved: z.boolean(),
  /** Signed URL, filled in Milestone 1. */
  thumbnail_url: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type ShelfItem = z.infer<typeof ShelfItem>;

export const ShelfResponse = z.object({
  items: z.array(ShelfItem),
});
export type ShelfResponse = z.infer<typeof ShelfResponse>;
