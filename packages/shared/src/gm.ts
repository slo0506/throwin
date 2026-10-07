import { z } from "zod";
import { ShelfItem, ValueRange } from "./api.js";
import { AskStatus, AutonomyLevel, ConditionGrade } from "./enums.js";
import { ItemReadiness } from "./readiness.js";

// GM conversation wire format (docs/contracts/m2-gm-and-asks.md). Keys are snake_case.

export const GmMode = z.enum(["intake", "chat"]);
export type GmMode = z.infer<typeof GmMode>;

/** POST /v1/gm/messages. At least 1 of text, choice or media_paths. */
export const PostGmMessage = z
  .strictObject({
    text: z.string().trim().min(1).max(4000).optional(),
    choice: z
      .strictObject({
        component_id: z.string().min(1).max(64),
        option_ids: z.array(z.string().min(1).max(64)).min(1).max(30),
      })
      .optional(),
    media_paths: z.array(z.string().min(1).max(300)).min(1).max(10).optional(),
    /**
     * Items the user just added to their Shelf, for example from the GM's camera request,
     * so the GM knows exactly which ones are new. Each must be the user's own.
     */
    added_item_ids: z.array(z.uuid()).min(1).max(30).optional(),
    /** The screen the user is on, for example "ask_detail". Volatile context only. */
    screen: z.string().trim().min(1).max(120).optional(),
  })
  .refine(
    (v) =>
      v.text !== undefined ||
      v.choice !== undefined ||
      v.media_paths !== undefined ||
      v.added_item_ids !== undefined,
    { message: "Send at least 1 of text, choice, media_paths or added_item_ids" },
  );
export type PostGmMessage = z.infer<typeof PostGmMessage>;

export const PostGmMessageResponse = z.object({
  stream_id: z.string(),
  message_id: z.uuid(),
});
export type PostGmMessageResponse = z.infer<typeof PostGmMessageResponse>;

/** Another member's Item as it may appear on a card. Only `showcase` Items appear. */
export const NetworkItemCard = z.object({
  id: z.uuid(),
  title: z.string(),
  category: z.string().nullable(),
  condition_grade: ConditionGrade.nullable(),
  value: ValueRange.nullable(),
  thumbnail_url: z.string().nullable(),
  owner_first_name: z.string(),
  readiness: ItemReadiness,
});
export type NetworkItemCard = z.infer<typeof NetworkItemCard>;

export const ItemCardsData = z.object({
  items: z.array(z.union([ShelfItem, NetworkItemCard])),
  selectable: z.boolean(),
  selected_ids: z.array(z.string()),
});
export type ItemCardsData = z.infer<typeof ItemCardsData>;

export const ChoiceOption = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  label: z.string().min(1).max(80),
  detail: z.string().max(160).optional(),
});
export type ChoiceOption = z.infer<typeof ChoiceOption>;

export const ChoicesData = z.object({
  prompt: z.string().min(1).max(200),
  options: z.array(ChoiceOption).min(2).max(6),
  multiple: z.boolean(),
});
export type ChoicesData = z.infer<typeof ChoicesData>;

export const CameraRequestData = z.object({
  instruction: z.string().min(1).max(200),
  item_id: z.uuid().optional(),
});
export type CameraRequestData = z.infer<typeof CameraRequestData>;

/**
 * The resolved target of an Ask. Mirrors the contract's Ask.target; the Asks module owns
 * the canonical schema and the two are reconciled when both land.
 */
export const AskCardTarget = z.object({
  kind: z.enum(["exact", "category"]),
  name: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  category: z.string().nullable(),
  constraints: z.array(z.string()),
  /** A reference product photo from the web, not the user's own. Null when none was found. */
  image_url: z.string().nullable().default(null),
  anchor: z
    .object({
      retail_cents: z.number().int().nonnegative().nullable(),
      used_low_cents: z.number().int().nonnegative(),
      used_high_cents: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AskCardTarget = z.infer<typeof AskCardTarget>;

/** The `ask_card` component data: the contract's Ask, filled by the server. */
export const AskCardData = z.object({
  id: z.uuid(),
  raw_text: z.string(),
  title: z.string().nullable(),
  status: AskStatus,
  status_line: z.string(),
  target: AskCardTarget.nullable(),
  offer_item_ids: z.array(z.uuid()),
  offer_value: z
    .object({ low_cents: z.number().int().nonnegative(), high_cents: z.number().int() })
    .nullable(),
  cash_ceiling_cents: z.number().int().min(0).max(100000),
  autonomy: AutonomyLevel,
  deadline: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type AskCardData = z.infer<typeof AskCardData>;

export const SampleDecision = z.object({
  give: z.string().min(1).max(120),
  get: z.string().min(1).max(120),
  verdict: z.enum(["yes", "no"]),
  why: z.string().min(1).max(200),
});
export type SampleDecision = z.infer<typeof SampleDecision>;

export const RecapData = z.object({
  paragraph: z.string().min(1).max(1200),
  sample_decisions: z.array(SampleDecision).length(3),
});
export type RecapData = z.infer<typeof RecapData>;

export const GmComponentKind = z.enum([
  "item_cards",
  "choices",
  "camera_request",
  "ask_card",
  "recap",
]);
export type GmComponentKind = z.infer<typeof GmComponentKind>;

export const GmComponent = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("item_cards"), data: ItemCardsData }),
  z.object({ id: z.string(), kind: z.literal("choices"), data: ChoicesData }),
  z.object({ id: z.string(), kind: z.literal("camera_request"), data: CameraRequestData }),
  z.object({ id: z.string(), kind: z.literal("ask_card"), data: AskCardData }),
  z.object({ id: z.string(), kind: z.literal("recap"), data: RecapData }),
]);
export type GmComponent = z.infer<typeof GmComponent>;

export const GmMessage = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  components: z.array(GmComponent),
  created_at: z.iso.datetime({ offset: true }),
});
export type GmMessage = z.infer<typeof GmMessage>;

export const GmConversation = z.object({
  conversation_id: z.uuid(),
  mode: GmMode,
  messages: z.array(GmMessage),
});
export type GmConversation = z.infer<typeof GmConversation>;

// ---------------------------------------------------------------------------
// Stream events (GET /v1/gm/stream/{stream_id}): `event: <name>` plus `data: <json>`.
// ---------------------------------------------------------------------------

export const GmTextEvent = z.object({ delta: z.string() });
export const GmProgressEvent = z.object({ label: z.string() });
export const GmDoneEvent = z.object({ message_id: z.uuid() });
export const GmErrorEvent = z.object({ code: z.string(), message: z.string() });

export type GmStreamEvent =
  | { event: "text"; data: z.infer<typeof GmTextEvent> }
  | { event: "progress"; data: z.infer<typeof GmProgressEvent> }
  | { event: "component"; data: GmComponent }
  | { event: "done"; data: z.infer<typeof GmDoneEvent> }
  | { event: "error"; data: z.infer<typeof GmErrorEvent> };

export const GM_STREAM_EVENTS = ["text", "progress", "component", "done", "error"] as const;
