import { z } from "zod";
import { AutonomyLevel, ConditionGrade, ItemStatus, ItemWillingness, MediaKind } from "./enums.js";
import { ItemReadiness, PhotoIssue, QuestionKind } from "./readiness.js";

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
  /** Kept for older clients: the prompt of the Item's best open question, or null. */
  follow_up: z.string().nullable(),
  /** True while the Appraiser or Refiner is still pricing or re-reading this Item. Value may be null. */
  is_appraising: z.boolean(),
  /** What the Item still needs, computed on the server: logged, identified or showcase. */
  readiness: ItemReadiness,
  /** 0 to 100 for the Item's best photo. Null until the Refiner has scored it. */
  photo_score: z.number().int().min(0).max(100).nullable(),
  photo_issues: z.array(PhotoIssue),
  /** Short labels of showcase angles still missing, e.g. "Both soles", "Size tag". */
  missing_angles: z.array(z.string()),
  /** True when photo_score is at least 50. */
  studio_allowed: z.boolean(),
  /** 2 to 3 plain sentences. Null until the Refiner writes it. */
  description: z.string().nullable(),
  /** How many Refiner questions are open for this Item. */
  open_questions: z.number().int().nonnegative(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type ShelfItem = z.infer<typeof ShelfItem>;

export const ShelfResponse = z.object({
  items: z.array(ShelfItem),
});
export type ShelfResponse = z.infer<typeof ShelfResponse>;

// ---------------------------------------------------------------------------
// Capture (Milestone 1): signed uploads, then a capture the Appraiser turns into Items.
// ---------------------------------------------------------------------------

export const CaptureStatus = z.enum(["uploading", "processing", "done", "failed"]);
export type CaptureStatus = z.infer<typeof CaptureStatus>;

export const UploadRequest = z.strictObject({
  count: z.number().int().min(1).max(30),
  kind: MediaKind.default("photo"),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const UploadResponse = z.object({
  capture_id: z.uuid(),
  uploads: z.array(z.object({ path: z.string(), upload_url: z.url() })),
});
export type UploadResponse = z.infer<typeof UploadResponse>;

export const CaptureMediaInput = z.strictObject({
  path: z.string().min(1).max(300),
  width: z.number().int().positive().max(10000).optional(),
  height: z.number().int().positive().max(10000).optional(),
  /** On-device sharpness score (variance of the Laplacian). Higher is sharper. */
  sharpness: z.number().nonnegative().optional(),
});

export const CaptureRequest = z.strictObject({
  capture_id: z.uuid(),
  media: z.array(CaptureMediaInput).min(1).max(30),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

export const CaptureProgress = z.object({
  stage: z.enum(["uploading", "detecting", "identifying", "pricing", "done", "failed"]).optional(),
  /** Plain-language status for the UI, e.g. "Pricing your LEGO Typewriter". */
  detail: z.string().optional(),
  found: z.number().int().nonnegative().optional(),
});

export const Capture = z.object({
  id: z.uuid(),
  status: CaptureStatus,
  media_count: z.number().int(),
  item_count: z.number().int(),
  progress: CaptureProgress,
  error: z.string().nullable(),
  items: z.array(ShelfItem),
  created_at: z.iso.datetime({ offset: true }),
});
export type Capture = z.infer<typeof Capture>;

export const ItemPatch = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    willingness: ItemWillingness,
    condition_grade: ConditionGrade,
    /** The owner confirmed our read of this Item: pins its identity and moves draft to on_shelf. */
    confirm: z.literal(true),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least 1 field is required" });
export type ItemPatch = z.infer<typeof ItemPatch>;

// ---------------------------------------------------------------------------
// Follow-up photos: answer an Item's follow_up with up to 5 more photos.
// ---------------------------------------------------------------------------

export const ItemMediaUploadRequest = z.strictObject({
  count: z.number().int().min(1).max(5),
});
export type ItemMediaUploadRequest = z.infer<typeof ItemMediaUploadRequest>;

export const ItemMediaUploadResponse = z.object({
  uploads: z.array(z.object({ path: z.string(), upload_url: z.url() })),
});
export type ItemMediaUploadResponse = z.infer<typeof ItemMediaUploadResponse>;

export const ItemMediaRequest = z.strictObject({
  media: z.array(CaptureMediaInput).min(1).max(5),
});
export type ItemMediaRequest = z.infer<typeof ItemMediaRequest>;

// ---------------------------------------------------------------------------
// Refiner questions (Tune up): the cheapest useful questions per Item, best first.
// ---------------------------------------------------------------------------

export const Question = z.object({
  id: z.uuid(),
  item_id: z.uuid(),
  item_title: z.string(),
  /** Signed URL of the Item's first photo, like /v1/items. */
  thumbnail_url: z.string().nullable(),
  kind: QuestionKind,
  prompt: z.string(),
  /**
   * yes_no: exactly ["Yes", "No", "Not sure"]. choice: 2 to 4 options plus "Not sure".
   * picker: the options to pick from. text and photo: empty (photo questions are answered
   * with the item media endpoints).
   */
  options: z.array(z.string()),
  created_at: z.iso.datetime({ offset: true }),
});
export type Question = z.infer<typeof Question>;

export const QuestionsQuery = z.strictObject({
  item_id: z.uuid().optional(),
});
export type QuestionsQuery = z.infer<typeof QuestionsQuery>;

export const QuestionsResponse = z.object({
  questions: z.array(Question).max(20),
});
export type QuestionsResponse = z.infer<typeof QuestionsResponse>;

/** 1 of the options (at most 200 characters for text questions), or a skip. */
export const AnswerRequest = z.union([
  z.strictObject({ answer: z.string().trim().min(1).max(200) }),
  z.strictObject({ skip: z.literal(true) }),
]);
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export const AnswerResponse = z.object({
  item: ShelfItem,
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;
