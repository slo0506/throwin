import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApprovalState,
  AskStatus,
  AskTarget,
  AutonomyLevel,
  CircleRole,
  ConditionGrade,
  CounterChange,
  compareQuestions,
  DEFAULT_NOTIFICATION_PREFS,
  DealStatus,
  ItemReadiness,
  ItemStatus,
  ItemWillingness,
  NotificationPrefs,
  QuestionKind,
  TasteFactCategory,
  TasteFactSource,
} from "@throwin/shared";
import { z } from "zod";
import {
  ACTIVE_ASK_STATUSES,
  type AcceptInviteResult,
  type AnswerInput,
  type AnswerResult,
  type AskInsert,
  type AskRecord,
  type AskUpdate,
  type AskUpdateResult,
  type CaptureMediaInput,
  type CaptureRecord,
  type CaptureStatus,
  type CircleMemberRecord,
  type CircleRecord,
  type CounterItemRecord,
  type CounterProposal,
  type DealDecisionResult,
  type DealItemRecord,
  type DealLegRecord,
  type DealRecord,
  type InvitePreviewRecord,
  type InviteRecord,
  type ItemRecord,
  type ItemUpdate,
  type MePatch,
  type MeRecord,
  type PhotoRequestRecord,
  type ProposeCounterResult,
  type QuestionRecord,
  type Repository,
  type RespondCounterResult,
  SHELF_STATUSES,
  type TasteFactRecord,
  type WithdrawCounterResult,
} from "./types.js";

const ts = z.string().transform((s) => new Date(s));
const isUuid = (id: string) => z.uuid().safeParse(id).success;

const ProfileRow = z.object({
  autonomy_level: AutonomyLevel,
  notification_prefs: z.record(z.string(), z.unknown()).nullable(),
  home_area: z.string().nullable(),
  default_handoff_place_id: z.string().nullable(),
});

const UserRow = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  photo_url: z.string().nullable(),
  created_at: ts,
  deleted_at: ts.nullable(),
  // One-to-one embed: PostgREST returns an object, older versions an array.
  profiles: z.union([ProfileRow, z.array(ProfileRow)]).nullable(),
});

const ItemRow = z.object({
  id: z.string(),
  owner_id: z.string(),
  status: ItemStatus,
  title: z.string(),
  willingness: ItemWillingness,
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  variant: z.string().nullable(),
  condition_grade: ConditionGrade.nullable(),
  defects: z.array(z.string()).nullable(),
  value_low_cents: z.number().int().nullable(),
  value_mid_cents: z.number().int().nullable(),
  value_high_cents: z.number().int().nullable(),
  identity_conf: z.number().nullable(),
  condition_conf: z.number().nullable(),
  reserved_by_deal_id: z.string().nullable(),
  appraising: z.boolean(),
  capture_id: z.string().nullable(),
  readiness: ItemReadiness,
  photo_score: z.number().int().nullable(),
  photo_issues: z.array(z.string()).nullable(),
  missing_angles: z.array(z.string()).nullable(),
  description: z.string().nullable(),
  item_media: z.array(z.object({ storage_path: z.string(), position: z.number() })).nullable(),
  item_questions: z
    .array(
      z.object({
        kind: QuestionKind,
        prompt: z.string(),
        impact: z.number(),
        status: z.string(),
        created_at: ts,
      }),
    )
    .nullable(),
  created_at: ts,
  updated_at: ts,
});

const QuestionRow = z.object({
  id: z.string(),
  item_id: z.string(),
  kind: QuestionKind,
  prompt: z.string(),
  options: z.array(z.string()),
  impact: z.number(),
  created_at: ts,
  // Many-to-one embed: an object, or an array on older PostgREST versions.
  items: z.union([
    z.object({
      title: z.string(),
      item_media: z.array(z.object({ storage_path: z.string(), position: z.number() })).nullable(),
    }),
    z
      .array(
        z.object({
          title: z.string(),
          item_media: z
            .array(z.object({ storage_path: z.string(), position: z.number() }))
            .nullable(),
        }),
      )
      .min(1),
  ]),
});

const AnswerRow = z.object({
  result: z.enum([
    "ok",
    "not_found",
    "already_answered",
    "item_reserved",
    "use_media_upload",
    "invalid_answer",
  ]),
  item_id: z.string().optional(),
});

const photosInOrder = (media: { storage_path: string; position: number }[] | null) =>
  [...(media ?? [])].sort((a, b) => a.position - b.position).map((m) => m.storage_path);
const firstPhoto = (media: { storage_path: string; position: number }[] | null) =>
  photosInOrder(media)[0] ?? null;

const CaptureRow = z.object({
  id: z.string(),
  user_id: z.string(),
  status: z.enum(["uploading", "processing", "done", "failed"]),
  media_count: z.number().int(),
  item_count: z.number().int(),
  progress: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  created_at: ts,
});

function toCapture(row: z.infer<typeof CaptureRow>): CaptureRecord {
  const p = row.progress ?? {};
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as CaptureStatus,
    mediaCount: row.media_count,
    itemCount: row.item_count,
    progress: {
      ...(typeof p.stage === "string" && { stage: p.stage }),
      ...(typeof p.detail === "string" && { detail: p.detail }),
      ...(typeof p.found === "number" && { found: p.found }),
    },
    error: row.error,
    createdAt: row.created_at,
  };
}

function toItem(r: z.infer<typeof ItemRow>): ItemRecord {
  const open = (r.item_questions ?? [])
    .filter((q) => q.status === "open")
    .map((q) => ({ ...q, createdAt: q.created_at }))
    .sort(compareQuestions);
  return {
    id: r.id,
    ownerId: r.owner_id,
    status: r.status,
    title: r.title,
    willingness: r.willingness,
    category: r.category,
    brand: r.brand,
    model: r.model,
    variant: r.variant,
    conditionGrade: r.condition_grade,
    defects: r.defects ?? [],
    valueLowCents: r.value_low_cents,
    valueMidCents: r.value_mid_cents,
    valueHighCents: r.value_high_cents,
    identityConf: r.identity_conf,
    conditionConf: r.condition_conf,
    reservedByDealId: r.reserved_by_deal_id,
    followUp: open[0]?.prompt ?? null,
    appraising: r.appraising,
    readiness: r.readiness,
    photoScore: r.photo_score,
    photoIssues: r.photo_issues ?? [],
    missingAngles: r.missing_angles ?? [],
    description: r.description,
    openQuestions: open.length,
    captureId: r.capture_id,
    thumbnailPath: firstPhoto(r.item_media),
    photoPaths: photosInOrder(r.item_media),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const OfferItemRow = z.object({
  status: ItemStatus,
  value_low_cents: z.number().int().nullable(),
  value_high_cents: z.number().int().nullable(),
});

const AskRow = z.object({
  id: z.string(),
  user_id: z.string(),
  raw_text: z.string(),
  title: z.string().nullable(),
  status: AskStatus,
  target: z.unknown(),
  cash_ceiling_cents: z.number().int(),
  max_items: z.number().int(),
  autonomy: AutonomyLevel,
  deadline: ts.nullable(),
  created_at: ts,
  updated_at: ts,
  offer_sets: z
    .array(
      z.object({
        item_id: z.string(),
        // Many-to-one embed: an object, or an array on older PostgREST versions.
        items: z.union([OfferItemRow, z.array(OfferItemRow)]).nullable(),
      }),
    )
    .nullable(),
});

/** A stored target that no longer parses (or the `{}` default) reads as unresolved. */
function parseTarget(raw: unknown): AskTarget | null {
  const parsed = AskTarget.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function toAsk(r: z.infer<typeof AskRow>): AskRecord {
  const offerItems = (r.offer_sets ?? []).flatMap((o) => {
    const item = Array.isArray(o.items) ? o.items[0] : o.items;
    if (!item || !SHELF_STATUSES.includes(item.status)) return [];
    return [
      { id: o.item_id, valueLowCents: item.value_low_cents, valueHighCents: item.value_high_cents },
    ];
  });
  return {
    id: r.id,
    userId: r.user_id,
    rawText: r.raw_text,
    title: r.title,
    status: r.status,
    target: parseTarget(r.target),
    offerItems,
    cashCeilingCents: r.cash_ceiling_cents,
    maxItems: r.max_items,
    autonomy: r.autonomy,
    deadline: r.deadline,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const TasteFactRow = z.object({
  id: z.string(),
  user_id: z.string(),
  key: z.string(),
  value: z.string(),
  category: TasteFactCategory,
  source: TasteFactSource,
  always_on: z.boolean(),
  status: z.enum(["active", "superseded", "deleted"]),
  created_at: ts,
});

const PatchAskRow = z.object({
  result: z.enum(["ok", "not_found", "invalid_offer_item", "ask_closed", "invalid_status"]),
});

const ASK_SELECT =
  "id, user_id, raw_text, title, status, target, cash_ceiling_cents, max_items, autonomy, deadline, created_at, updated_at, offer_sets(item_id, items(status, value_low_cents, value_high_cents))";
const TASTE_FACT_SELECT =
  "id, user_id, key, value, category, source, always_on, status, created_at";

const CircleRow = z.object({
  id: z.string(),
  name: z.string(),
  category_focus: z.array(z.string()),
  status: z.enum(["active", "paused"]),
  created_at: ts,
});
const CIRCLE_SELECT = "id, name, category_focus, status, created_at";

// Many-to-one embeds come back as objects.
const MembershipRow = z.object({ role: CircleRole, circles: CircleRow });

const MemberRow = z.object({
  user_id: z.string(),
  role: CircleRole,
  joined_at: ts,
  users: z.object({
    display_name: z.string().nullable(),
    photo_url: z.string().nullable(),
    deleted_at: z.string().nullable(),
  }),
});

const InviteRow = z.object({
  code: z.string(),
  circle_id: z.string(),
  max_uses: z.number().int(),
  uses: z.number().int(),
  expires_at: ts,
});

const InvitePreviewRow = InviteRow.extend({
  circles: z.object({ name: z.string(), status: z.enum(["active", "paused"]) }),
  users: z.object({ display_name: z.string().nullable() }).nullable(),
});

const AcceptInviteRow = z.object({
  result: z.enum(["ok", "already_member", "not_found", "expired", "full"]),
  circle_id: z.string().optional(),
});

const DealRow = z.object({
  id: z.string(),
  status: DealStatus,
  expires_at: ts,
  created_at: ts,
  counter_rounds: z.number().int(),
  superseded_by: z.string().nullable(),
});
const DealLegRow = z.object({
  deal_id: z.string(),
  giver_id: z.string(),
  receiver_id: z.string(),
  item_id: z.string().nullable(),
  ask_id: z.string().nullable(),
  giver_ask_id: z.string().nullable(),
  throw_in_cents: z.number().int(),
});
const DealItemRow = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  condition_grade: ConditionGrade.nullable(),
  value_low_cents: z.number().int().nullable(),
  value_mid_cents: z.number().int().nullable(),
  value_high_cents: z.number().int().nullable(),
  item_media: z.array(z.object({ storage_path: z.string(), position: z.number() })).nullable(),
});
const DealParticipantRow = z.object({
  deal_id: z.string(),
  user_id: z.string(),
  approval: ApprovalState,
  why: z.string().nullable(),
  users: z.object({ display_name: z.string().nullable(), photo_url: z.string().nullable() }),
});
const DecisionRow = z.object({
  result: z.enum(["ok", "not_found", "closed", "decided", "counter_open"]),
});
const CounterRow = z.object({
  id: z.string(),
  deal_id: z.string(),
  proposed_by: z.string(),
  changes: z.array(CounterChange),
  proposal: z.object({
    item_legs: z.array(
      z.object({
        giver: z.string(),
        receiver: z.string(),
        item_id: z.string(),
        ask_id: z.string().nullable().optional(),
        giver_ask_id: z.string().nullable().optional(),
      }),
    ),
    cash_legs: z.array(
      z.object({ payer: z.string(), payee: z.string(), amount_cents: z.number() }),
    ),
  }),
  awaiting: z.array(z.string()),
  answers: z.record(z.string(), z.enum(["accepted", "declined"])),
  expires_at: ts,
});
const DEAL_ITEM_SELECT =
  "id, title, category, brand, model, condition_grade, value_low_cents, value_mid_cents, value_high_cents, item_media(storage_path, position)";

function toDealItem(i: z.infer<typeof DealItemRow>): DealItemRecord {
  const photo = [...(i.item_media ?? [])].sort((a, b) => a.position - b.position)[0];
  return {
    id: i.id,
    title: i.title,
    category: i.category,
    brand: i.brand,
    model: i.model,
    conditionGrade: i.condition_grade,
    valueLowCents: i.value_low_cents,
    valueMidCents: i.value_mid_cents,
    valueHighCents: i.value_high_cents,
    photoPath: photo?.storage_path ?? null,
  };
}

/** Deal Sheets show Deals from awaiting approval onward; staged ones stay hidden. */
const SHOWN_DEAL_STATUSES = [
  "pending_approvals",
  "approved",
  "scheduling",
  "in_handoff",
  "completed",
  "failed",
  "cancelled",
];
const OPEN_DEAL_STATUSES = ["pending_approvals", "approved", "scheduling", "in_handoff"];

const toInvite = (r: z.infer<typeof InviteRow>): InviteRecord => ({
  code: r.code,
  circleId: r.circle_id,
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at,
});

const USER_SELECT =
  "id, display_name, photo_url, created_at, deleted_at, profiles(autonomy_level, notification_prefs, home_area, default_handoff_place_id)";
const ITEM_SELECT =
  "id, owner_id, status, title, willingness, category, brand, model, variant, condition_grade, defects, value_low_cents, value_mid_cents, value_high_cents, identity_conf, condition_conf, reserved_by_deal_id, appraising, capture_id, readiness, photo_score, photo_issues, missing_angles, description, item_media(storage_path, position), item_questions(kind, prompt, impact, status, created_at), created_at, updated_at";
const CAPTURE_SELECT = "id, user_id, status, media_count, item_count, progress, error, created_at";

export class RepositoryError extends Error {
  constructor(operation: string, cause: { message: string; code?: string }) {
    super(`${operation} failed: ${cause.message}${cause.code ? ` (${cause.code})` : ""}`);
    this.name = "RepositoryError";
  }
}

function toCircle(
  r: z.infer<typeof CircleRow>,
  role: CircleRole,
  memberCount: number,
): CircleRecord {
  return {
    id: r.id,
    name: r.name,
    categoryFocus: r.category_focus,
    role,
    memberCount,
    createdAt: r.created_at,
  };
}

function mergePrefs(raw: Record<string, unknown> | null | undefined): NotificationPrefs {
  const parsed = NotificationPrefs.partial().safeParse(raw ?? {});
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(parsed.success ? parsed.data : {}) };
}

/**
 * Repository backed by Supabase with the service role key. The service role bypasses RLS,
 * so every query here filters by the caller's user ID explicitly.
 */
export class SupabaseRepository implements Repository {
  constructor(private readonly db: SupabaseClient) {}

  async getMe(userId: string): Promise<MeRecord | null> {
    const { data, error } = await this.db
      .from("users")
      .select(USER_SELECT)
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new RepositoryError("getMe", error);
    if (!data) return null;
    const row = UserRow.parse(data);
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    const counts = await this.#counts(userId);
    return {
      id: row.id,
      displayName: row.display_name,
      photoUrl: row.photo_url,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
      autonomyLevel: profile?.autonomy_level ?? "every_deal",
      notificationPrefs: mergePrefs(profile?.notification_prefs),
      homeArea: profile?.home_area ?? null,
      defaultHandoffPlaceId: profile?.default_handoff_place_id ?? null,
      counts,
    };
  }

  async updateMe(userId: string, patch: MePatch): Promise<MeRecord | null> {
    const userFields: Record<string, unknown> = {};
    if (patch.displayName !== undefined) userFields.display_name = patch.displayName;
    if (patch.photoUrl !== undefined) userFields.photo_url = patch.photoUrl;
    if (Object.keys(userFields).length > 0) {
      const { error } = await this.db.from("users").update(userFields).eq("id", userId);
      if (error) throw new RepositoryError("updateMe.users", error);
    }

    const profileFields: Record<string, unknown> = {};
    if (patch.autonomyLevel !== undefined) profileFields.autonomy_level = patch.autonomyLevel;
    if (patch.notificationPrefs) {
      // Read-merge-write. Concurrent prefs edits from 1 user are rare enough for v1.
      const { data, error } = await this.db
        .from("profiles")
        .select("notification_prefs")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RepositoryError("updateMe.readPrefs", error);
      const current = mergePrefs(
        (data as { notification_prefs?: Record<string, unknown> } | null)?.notification_prefs,
      );
      profileFields.notification_prefs = { ...current, ...patch.notificationPrefs };
    }
    if (Object.keys(profileFields).length > 0) {
      const { error } = await this.db.from("profiles").update(profileFields).eq("user_id", userId);
      if (error) throw new RepositoryError("updateMe.profiles", error);
    }
    if (patch.autonomyLevel !== undefined) {
      // Which deals to bring you is 1 setting for every Ask: open Asks follow it.
      const { error } = await this.db
        .from("asks")
        .update({ autonomy: patch.autonomyLevel })
        .eq("user_id", userId)
        .in("status", ACTIVE_ASK_STATUSES);
      if (error) throw new RepositoryError("updateMe.asks", error);
    }
    return this.getMe(userId);
  }

  async softDeleteUser(userId: string, at: Date): Promise<Date | null> {
    const { error } = await this.db
      .from("users")
      .update({ deleted_at: at.toISOString() })
      .eq("id", userId)
      .is("deleted_at", null);
    if (error) throw new RepositoryError("softDeleteUser", error);
    const { data, error: readError } = await this.db
      .from("users")
      .select("deleted_at")
      .eq("id", userId)
      .maybeSingle();
    if (readError) throw new RepositoryError("softDeleteUser.read", readError);
    const deletedAt = (data as { deleted_at: string | null } | null)?.deleted_at;
    return deletedAt ? new Date(deletedAt) : null;
  }

  async listShelfItems(userId: string): Promise<ItemRecord[]> {
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_SELECT)
      .eq("owner_id", userId)
      .in("status", [...SHELF_STATUSES])
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new RepositoryError("listShelfItems", error);
    return z
      .array(ItemRow)
      .parse(data ?? [])
      .map(toItem);
  }

  async updateItem(userId: string, itemId: string, update: ItemUpdate): Promise<ItemRecord | null> {
    const fields: Record<string, unknown> = {};
    if (update.title !== undefined) fields.title = update.title;
    if (update.willingness !== undefined) fields.willingness = update.willingness;
    if (update.conditionGrade !== undefined) fields.condition_grade = update.conditionGrade;
    if (Object.keys(fields).length > 0) {
      const { error } = await this.db
        .from("items")
        .update(fields)
        .eq("id", itemId)
        .eq("owner_id", userId)
        .in("status", [...SHELF_STATUSES]);
      if (error) throw new RepositoryError("updateItem", error);
    }
    if (update.confirm) {
      // Pins identity; the readiness trigger recomputes readiness on this write.
      const pin = await this.db
        .from("items")
        .update({ identity_confirmed: true })
        .eq("id", itemId)
        .eq("owner_id", userId)
        .in("status", [...SHELF_STATUSES]);
      if (pin.error) throw new RepositoryError("updateItem.confirm", pin.error);
      const { error } = await this.db
        .from("items")
        .update({ status: "on_shelf" })
        .eq("id", itemId)
        .eq("owner_id", userId)
        .in("status", ["draft", "needs_photos"]);
      if (error) throw new RepositoryError("updateItem.confirm", error);
    }
    return this.#getItem(userId, itemId);
  }

  async getItem(userId: string, itemId: string): Promise<ItemRecord | null> {
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_SELECT)
      .eq("id", itemId)
      .eq("owner_id", userId)
      .neq("status", "removed")
      .maybeSingle();
    if (error) throw new RepositoryError("getItem", error);
    return data ? toItem(ItemRow.parse(data)) : null;
  }

  async submitItemMedia(
    userId: string,
    itemId: string,
    media: CaptureMediaInput[],
  ): Promise<ItemRecord | "not_found" | "conflict"> {
    const { data, error } = await this.db.rpc("submit_item_media", {
      p_user_id: userId,
      p_item_id: itemId,
      p_media: media,
    });
    // object_in_use: a Deal holds the Item, or it is already being appraised.
    if (error?.code === "55006") return "conflict";
    if (error) throw new RepositoryError("submitItemMedia", error);
    if (!data || (data as { id?: string | null }).id == null) return "not_found";
    return (await this.getItem(userId, itemId)) ?? "not_found";
  }

  async removeItem(userId: string, itemId: string): Promise<"removed" | "not_found" | "reserved"> {
    const item = await this.#getItem(userId, itemId);
    if (!item) return "not_found";
    if (item.reservedByDealId) return "reserved";
    const { error } = await this.db
      .from("items")
      .update({ status: "removed" })
      .eq("id", itemId)
      .eq("owner_id", userId)
      .is("reserved_by_deal_id", null);
    if (error) throw new RepositoryError("removeItem", error);
    return "removed";
  }

  async listOpenQuestions(userId: string, itemId?: string): Promise<QuestionRecord[]> {
    let query = this.db
      .from("item_questions")
      .select(
        "id, item_id, kind, prompt, options, impact, created_at, items!inner(title, owner_id, status, item_media(storage_path, position))",
      )
      .eq("status", "open")
      .eq("items.owner_id", userId)
      .in("items.status", [...SHELF_STATUSES])
      .order("created_at", { ascending: true })
      .limit(200);
    if (itemId) query = query.eq("item_id", itemId);
    const { data, error } = await query;
    if (error) throw new RepositoryError("listOpenQuestions", error);
    return z
      .array(QuestionRow)
      .parse(data ?? [])
      .map((q) => {
        const item = Array.isArray(q.items) ? (q.items[0] as (typeof q.items)[0]) : q.items;
        return {
          id: q.id,
          itemId: q.item_id,
          itemTitle: item.title,
          thumbnailPath: firstPhoto(item.item_media),
          kind: q.kind,
          prompt: q.prompt,
          options: q.options,
          impact: q.impact,
          createdAt: q.created_at,
        };
      });
  }

  async answerQuestion(
    userId: string,
    questionId: string,
    input: AnswerInput,
  ): Promise<AnswerResult> {
    const skip = "skip" in input;
    const { data, error } = await this.db.rpc("answer_item_question", {
      p_user_id: userId,
      p_question_id: questionId,
      p_answer: skip ? null : input.answer,
      p_skip: skip,
    });
    if (error) throw new RepositoryError("answerQuestion", error);
    const row = AnswerRow.parse(data);
    if (row.result === "ok") {
      if (!row.item_id) throw new RepositoryError("answerQuestion", { message: "no item_id" });
      return { result: "ok", itemId: row.item_id };
    }
    return { result: row.result };
  }

  async createCapture(
    userId: string,
    mediaCount: number,
    _kind: "photo" | "frame",
  ): Promise<CaptureRecord> {
    const { data, error } = await this.db
      .from("captures")
      .insert({ user_id: userId, media_count: mediaCount, progress: { stage: "uploading" } })
      .select(CAPTURE_SELECT)
      .single();
    if (error) throw new RepositoryError("createCapture", error);
    return toCapture(CaptureRow.parse(data));
  }

  async getCapture(userId: string, captureId: string): Promise<CaptureRecord | null> {
    const { data, error } = await this.db
      .from("captures")
      .select(CAPTURE_SELECT)
      .eq("id", captureId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new RepositoryError("getCapture", error);
    return data ? toCapture(CaptureRow.parse(data)) : null;
  }

  async submitCapture(
    userId: string,
    captureId: string,
    media: CaptureMediaInput[],
  ): Promise<CaptureRecord | null> {
    const { data, error } = await this.db.rpc("submit_capture", {
      p_user_id: userId,
      p_capture_id: captureId,
      p_media: media,
    });
    if (error) throw new RepositoryError("submitCapture", error);
    if (!data || (data as { id?: string | null }).id == null) return null;
    return toCapture(CaptureRow.parse(data));
  }

  async listCaptureItems(userId: string, captureId: string): Promise<ItemRecord[]> {
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_SELECT)
      .eq("owner_id", userId)
      .eq("capture_id", captureId)
      .in("status", [...SHELF_STATUSES])
      .order("created_at", { ascending: true });
    if (error) throw new RepositoryError("listCaptureItems", error);
    return z
      .array(ItemRow)
      .parse(data ?? [])
      .map(toItem);
  }

  async listAsks(userId: string): Promise<AskRecord[]> {
    const { data, error } = await this.db
      .from("asks")
      .select(ASK_SELECT)
      .eq("user_id", userId)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new RepositoryError("listAsks", error);
    return z
      .array(AskRow)
      .parse(data ?? [])
      .map(toAsk);
  }

  async getAsk(userId: string, askId: string): Promise<AskRecord | null> {
    const { data, error } = await this.db
      .from("asks")
      .select(ASK_SELECT)
      .eq("id", askId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new RepositoryError("getAsk", error);
    return data ? toAsk(AskRow.parse(data)) : null;
  }

  async createAsk(userId: string, input: AskInsert): Promise<AskRecord> {
    const { data, error } = await this.db
      .from("asks")
      .insert({
        user_id: userId,
        raw_text: input.rawText,
        target: input.target ?? {},
        title: input.title,
        status: input.status,
        cash_ceiling_cents: input.cashCeilingCents,
        max_items: input.maxItems,
        autonomy: input.autonomy,
      })
      .select(ASK_SELECT)
      .single();
    if (error) throw new RepositoryError("createAsk", error);
    return toAsk(AskRow.parse(data));
  }

  async updateAsk(userId: string, askId: string, update: AskUpdate): Promise<AskUpdateResult> {
    const patch: Record<string, unknown> = {};
    if (update.rawText !== undefined) patch.raw_text = update.rawText;
    if (update.target !== undefined) patch.target = update.target;
    if (update.title !== undefined) patch.title = update.title;
    if (update.offerItemIds !== undefined) patch.offer_item_ids = update.offerItemIds;
    if (update.cashCeilingCents !== undefined) patch.cash_ceiling_cents = update.cashCeilingCents;
    if (update.maxItems !== undefined) patch.max_items = update.maxItems;
    if (update.autonomy !== undefined) patch.autonomy = update.autonomy;
    if (update.deadline !== undefined) patch.deadline = update.deadline?.toISOString() ?? null;
    if (update.cancel) patch.status = "cancelled";
    const { data, error } = await this.db.rpc("patch_ask", {
      p_user_id: userId,
      p_ask_id: askId,
      p_patch: patch,
    });
    if (error) throw new RepositoryError("updateAsk", error);
    const { result } = PatchAskRow.parse(data);
    if (result === "not_found" || result === "invalid_offer_item" || result === "ask_closed") {
      return result;
    }
    // The route only ever sends status "cancelled", so invalid_status means a bug here.
    if (result === "invalid_status") {
      throw new RepositoryError("updateAsk", { message: "invalid_status" });
    }
    return (await this.getAsk(userId, askId)) ?? "not_found";
  }

  async listCircles(userId: string): Promise<CircleRecord[]> {
    const { data, error } = await this.db
      .from("circle_members")
      .select(`role, circles(${CIRCLE_SELECT})`)
      .eq("user_id", userId)
      .order("joined_at", { ascending: true });
    if (error) throw new RepositoryError("listCircles", error);
    const rows = z.array(MembershipRow).parse(data ?? []);
    const counts = await this.#memberCounts(rows.map((r) => r.circles.id));
    return rows.map((r) => toCircle(r.circles, r.role, counts.get(r.circles.id) ?? 1));
  }

  async getCircle(userId: string, circleId: string) {
    const { data, error } = await this.db
      .from("circle_members")
      .select(`role, circles(${CIRCLE_SELECT})`)
      .eq("user_id", userId)
      .eq("circle_id", circleId)
      .maybeSingle();
    if (error) throw new RepositoryError("getCircle", error);
    if (!data) return null;
    const mine = MembershipRow.parse(data);

    const members = await this.db
      .from("circle_members")
      .select("user_id, role, joined_at, users(display_name, photo_url, deleted_at)")
      .eq("circle_id", circleId)
      .order("joined_at", { ascending: true });
    if (members.error) throw new RepositoryError("getCircle.members", members.error);
    const rows = z.array(MemberRow).parse(members.data ?? []);
    const visible: CircleMemberRecord[] = rows
      .filter((r) => r.users.deleted_at === null)
      .map((r) => ({
        userId: r.user_id,
        displayName: r.users.display_name,
        photoUrl: r.users.photo_url,
        role: r.role,
        joinedAt: r.joined_at,
      }));
    return { ...toCircle(mine.circles, mine.role, rows.length), members: visible };
  }

  async createCircle(userId: string, input: { name: string; categoryFocus: string[] }) {
    const { data, error } = await this.db
      .from("circles")
      .insert({ name: input.name, owner_id: userId, category_focus: input.categoryFocus })
      .select(CIRCLE_SELECT)
      .single();
    if (error) throw new RepositoryError("createCircle", error);
    // on_circle_created made the owner its first member.
    return toCircle(CircleRow.parse(data), "owner", 1);
  }

  async createInvite(
    userId: string,
    circleId: string,
    input: { code: string; maxUses: number; expiresAt: Date },
  ): Promise<InviteRecord | null> {
    if (!(await this.getCircle(userId, circleId))) return null;
    const { data, error } = await this.db
      .from("invites")
      .insert({
        code: input.code,
        circle_id: circleId,
        created_by: userId,
        max_uses: input.maxUses,
        expires_at: input.expiresAt.toISOString(),
      })
      .select("code, circle_id, max_uses, uses, expires_at")
      .single();
    if (error) throw new RepositoryError("createInvite", error);
    return toInvite(InviteRow.parse(data));
  }

  async previewInvite(
    userId: string,
    code: string,
    now: Date,
  ): Promise<InvitePreviewRecord | null> {
    const { data, error } = await this.db
      .from("invites")
      .select(
        "code, circle_id, max_uses, uses, expires_at, circles(name, status), users(display_name)",
      )
      .eq("code", code)
      .maybeSingle();
    if (error) throw new RepositoryError("previewInvite", error);
    if (!data) return null;
    const row = InvitePreviewRow.parse(data);
    if (row.circles.status !== "active") return null;
    const [counts, member] = await Promise.all([
      this.#memberCounts([row.circle_id]),
      this.db
        .from("circle_members")
        .select("user_id", { count: "exact", head: true })
        .eq("circle_id", row.circle_id)
        .eq("user_id", userId),
    ]);
    if (member.error) throw new RepositoryError("previewInvite.member", member.error);
    const status: InvitePreviewRecord["status"] =
      (member.count ?? 0) > 0
        ? "already_member"
        : row.expires_at.getTime() <= now.getTime()
          ? "expired"
          : row.uses >= row.max_uses
            ? "full"
            : "open";
    return {
      code: row.code,
      circleName: row.circles.name,
      inviterName: row.users?.display_name ?? null,
      memberCount: counts.get(row.circle_id) ?? 1,
      status,
    };
  }

  async acceptInvite(userId: string, code: string): Promise<AcceptInviteResult> {
    const { data, error } = await this.db.rpc("accept_invite", {
      p_user_id: userId,
      p_code: code,
    });
    if (error) throw new RepositoryError("acceptInvite", error);
    const row = AcceptInviteRow.parse(data);
    if (row.result === "ok" || row.result === "already_member") {
      if (!row.circle_id) throw new RepositoryError("acceptInvite", { message: "no circle_id" });
      return { joined: row.result === "ok", circleId: row.circle_id };
    }
    return row.result;
  }

  async listDeals(userId: string): Promise<DealRecord[]> {
    return this.#deals(userId, null, OPEN_DEAL_STATUSES);
  }

  async getDeal(userId: string, dealId: string): Promise<DealRecord | null> {
    return (await this.#deals(userId, dealId, SHOWN_DEAL_STATUSES))[0] ?? null;
  }

  async listPhotoRequests(userId: string): Promise<PhotoRequestRecord[]> {
    const own = await this.db.from("deal_participants").select("deal_id").eq("user_id", userId);
    if (own.error) throw new RepositoryError("photoRequests.mine", own.error);
    const ids = ((own.data ?? []) as { deal_id: string }[]).map((r) => r.deal_id);
    if (ids.length === 0) return [];
    const deals = await this.db
      .from("deals")
      .select("id, expires_at")
      .in("id", ids)
      .eq("status", "staged");
    if (deals.error) throw new RepositoryError("photoRequests.deals", deals.error);
    const staged = z.array(z.object({ id: z.string(), expires_at: ts })).parse(deals.data ?? []);
    if (staged.length === 0) return [];

    const legs = await this.db
      .from("deal_legs")
      .select("deal_id, receiver_id, item_id")
      .in(
        "deal_id",
        staged.map((d) => d.id),
      )
      .eq("giver_id", userId)
      .not("item_id", "is", null);
    if (legs.error) throw new RepositoryError("photoRequests.legs", legs.error);
    const legRows = z
      .array(z.object({ deal_id: z.string(), receiver_id: z.string(), item_id: z.string() }))
      .parse(legs.data ?? []);
    if (legRows.length === 0) return [];

    const [items, users] = await Promise.all([
      this.db
        .from("items")
        .select("id, title, readiness, missing_angles, item_media(storage_path, position)")
        .in(
          "id",
          legRows.map((l) => l.item_id),
        )
        .neq("readiness", "showcase"),
      this.db
        .from("users")
        .select("id, display_name")
        .in("id", [...new Set(legRows.map((l) => l.receiver_id))]),
    ]);
    if (items.error) throw new RepositoryError("photoRequests.items", items.error);
    if (users.error) throw new RepositoryError("photoRequests.users", users.error);
    const itemById = new Map(
      z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            missing_angles: z.array(z.string()).nullable(),
            item_media: z
              .array(z.object({ storage_path: z.string(), position: z.number() }))
              .nullable(),
          }),
        )
        .parse(items.data ?? [])
        .map((i) => [i.id, i]),
    );
    const names = new Map(
      z
        .array(z.object({ id: z.string(), display_name: z.string().nullable() }))
        .parse(users.data ?? [])
        .map((u) => [u.id, u.display_name?.trim().split(/\s+/)[0] || null]),
    );
    const expiry = new Map(staged.map((d) => [d.id, d.expires_at]));
    return legRows.flatMap((l) => {
      const item = itemById.get(l.item_id);
      if (!item) return [];
      return [
        {
          dealId: l.deal_id,
          expiresAt: expiry.get(l.deal_id) as Date,
          itemId: item.id,
          itemTitle: item.title,
          missingAngles: item.missing_angles ?? [],
          thumbnailPath: firstPhoto(item.item_media),
          wantedBy: names.get(l.receiver_id) ?? null,
        },
      ];
    });
  }

  async approveDeal(userId: string, dealId: string, snapshot: unknown) {
    return this.#decide("approve_deal", userId, dealId, { p_snapshot: snapshot });
  }

  async declineDeal(userId: string, dealId: string, reason: string | null) {
    return this.#decide("decline_deal", userId, dealId, { p_reason: reason });
  }

  async #decide(
    fn: "approve_deal" | "decline_deal",
    userId: string,
    dealId: string,
    extra: Record<string, unknown>,
  ): Promise<DealDecisionResult> {
    const { data, error } = await this.db.rpc(fn, {
      p_user_id: userId,
      p_deal_id: dealId,
      ...extra,
    });
    if (error) throw new RepositoryError(fn, error);
    const { result } = DecisionRow.parse(data);
    if (result !== "ok") return result;
    return (await this.getDeal(userId, dealId)) ?? "not_found";
  }

  /** The user's Deals in these statuses (1 when dealId is set), assembled in 5 reads. */
  async #deals(userId: string, dealId: string | null, statuses: string[]): Promise<DealRecord[]> {
    let mine = this.db.from("deal_participants").select("deal_id").eq("user_id", userId);
    if (dealId) mine = mine.eq("deal_id", dealId);
    const own = await mine;
    if (own.error) throw new RepositoryError("deals.mine", own.error);
    const ids = ((own.data ?? []) as { deal_id: string }[]).map((r) => r.deal_id);
    if (ids.length === 0) return [];

    const deals = await this.db
      .from("deals")
      .select("id, status, expires_at, created_at, counter_rounds, superseded_by")
      .in("id", ids)
      .in("status", statuses)
      .order("created_at", { ascending: false });
    if (deals.error) throw new RepositoryError("deals", deals.error);
    const dealRows = z.array(DealRow).parse(deals.data ?? []);
    if (dealRows.length === 0) return [];
    const shownIds = dealRows.map((d) => d.id);

    const [legs, people, counters] = await Promise.all([
      this.db
        .from("deal_legs")
        .select("deal_id, giver_id, receiver_id, item_id, ask_id, giver_ask_id, throw_in_cents")
        .in("deal_id", shownIds),
      this.db
        .from("deal_participants")
        .select("deal_id, user_id, approval, why, users(display_name, photo_url)")
        .in("deal_id", shownIds),
      this.db
        .from("deal_counters")
        .select("id, deal_id, proposed_by, changes, proposal, awaiting, answers, expires_at")
        .in("deal_id", shownIds)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString()),
    ]);
    if (legs.error) throw new RepositoryError("deals.legs", legs.error);
    if (people.error) throw new RepositoryError("deals.participants", people.error);
    if (counters.error) throw new RepositoryError("deals.counters", counters.error);
    const legRows = z.array(DealLegRow).parse(legs.data ?? []);
    const peopleRows = z.array(DealParticipantRow).parse(people.data ?? []);
    const counterRows = z.array(CounterRow).parse(counters.data ?? []);

    const itemIds = [
      ...new Set([
        ...legRows.flatMap((l) => (l.item_id ? [l.item_id] : [])),
        ...counterRows.flatMap((c) => c.proposal.item_legs.map((l) => l.item_id)),
      ]),
    ];
    const items = await this.db.from("items").select(DEAL_ITEM_SELECT).in("id", itemIds);
    if (items.error) throw new RepositoryError("deals.items", items.error);
    const itemById = new Map(
      z
        .array(DealItemRow)
        .parse(items.data ?? [])
        .map((i) => [i.id, toDealItem(i)]),
    );
    const leg = (l: {
      giverId: string;
      receiverId: string;
      itemId: string;
      askId: string | null;
      giverAskId: string | null;
    }): DealLegRecord[] => {
      const item = itemById.get(l.itemId);
      return item
        ? [
            {
              giverId: l.giverId,
              receiverId: l.receiverId,
              askId: l.askId,
              giverAskId: l.giverAskId,
              item,
            },
          ]
        : [];
    };

    return dealRows.map((d) => {
      const c = counterRows.find((r) => r.deal_id === d.id);
      return {
        id: d.id,
        status: d.status,
        expiresAt: d.expires_at,
        legs: legRows
          .filter((l) => l.deal_id === d.id && l.item_id)
          .flatMap((l) =>
            leg({
              giverId: l.giver_id,
              receiverId: l.receiver_id,
              itemId: l.item_id as string,
              askId: l.ask_id,
              giverAskId: l.giver_ask_id,
            }),
          ),
        throwIns: legRows
          .filter((l) => l.deal_id === d.id && !l.item_id && l.throw_in_cents > 0)
          .map((l) => ({
            payerId: l.giver_id,
            payeeId: l.receiver_id,
            amountCents: l.throw_in_cents,
          })),
        participants: peopleRows
          .filter((p) => p.deal_id === d.id)
          .map((p) => ({
            userId: p.user_id,
            displayName: p.users.display_name,
            photoUrl: p.users.photo_url,
            approval: p.approval,
            why: p.why,
          })),
        counterRounds: d.counter_rounds,
        supersededBy: d.superseded_by,
        counter: c
          ? {
              id: c.id,
              proposedBy: c.proposed_by,
              changes: c.changes,
              legs: c.proposal.item_legs.flatMap((l) =>
                leg({
                  giverId: l.giver,
                  receiverId: l.receiver,
                  itemId: l.item_id,
                  askId: l.ask_id ?? null,
                  giverAskId: l.giver_ask_id ?? null,
                }),
              ),
              throwIns: c.proposal.cash_legs.map((t) => ({
                payerId: t.payer,
                payeeId: t.payee,
                amountCents: t.amount_cents,
              })),
              awaiting: c.awaiting,
              answers: c.answers,
              expiresAt: c.expires_at,
            }
          : null,
      };
    });
  }

  async getCounterItems(itemIds: string[]): Promise<CounterItemRecord[]> {
    const ids = itemIds.filter(isUuid);
    if (ids.length === 0) return [];
    const { data, error } = await this.db
      .from("items")
      .select(`${DEAL_ITEM_SELECT}, owner_id, status, willingness, reserved_by_deal_id`)
      .in("id", ids);
    if (error) throw new RepositoryError("getCounterItems", error);
    return z
      .array(
        DealItemRow.extend({
          owner_id: z.string(),
          status: ItemStatus,
          willingness: ItemWillingness,
          reserved_by_deal_id: z.string().nullable(),
        }),
      )
      .parse(data ?? [])
      .map((r) => ({
        ownerId: r.owner_id,
        status: r.status,
        reserved: r.reserved_by_deal_id !== null,
        willingness: r.willingness,
        item: toDealItem(r),
      }));
  }

  async getAskCeilings(askIds: string[]): Promise<Map<string, number>> {
    const ids = askIds.filter(isUuid);
    if (ids.length === 0) return new Map();
    const { data, error } = await this.db
      .from("asks")
      .select("id, cash_ceiling_cents")
      .in("id", ids);
    if (error) throw new RepositoryError("getAskCeilings", error);
    return new Map(
      z
        .array(z.object({ id: z.string(), cash_ceiling_cents: z.number().int() }))
        .parse(data ?? [])
        .map((r) => [r.id, r.cash_ceiling_cents]),
    );
  }

  async proposeCounter(
    userId: string,
    dealId: string,
    counter: CounterProposal,
  ): Promise<ProposeCounterResult> {
    const { data, error } = await this.db.rpc("propose_counter", {
      p_user_id: userId,
      p_deal_id: dealId,
      p_changes: counter.changes,
      p_proposal: counter.proposal,
      p_awaiting: counter.awaiting,
    });
    if (error) throw new RepositoryError("proposeCounter", error);
    const { result } = z
      .object({
        result: z.enum(["ok", "not_found", "closed", "counter_open", "no_rounds_left", "invalid"]),
      })
      .parse(data);
    if (result !== "ok") return result;
    return (await this.getDeal(userId, dealId)) ?? "not_found";
  }

  async respondCounter(
    userId: string,
    dealId: string,
    counterId: string,
    accept: boolean,
  ): Promise<RespondCounterResult> {
    if (!(await this.#counterOf(counterId, dealId))) return "not_found";
    const { data, error } = await this.db.rpc("respond_counter", {
      p_user_id: userId,
      p_counter_id: counterId,
      p_accept: accept,
    });
    if (error) throw new RepositoryError("respondCounter", error);
    const row = z
      .object({
        result: z.enum(["ok", "not_found", "closed", "decided", "items_taken"]),
        deal_id: z.string().optional(),
      })
      .parse(data);
    if (row.result !== "ok") return row.result;
    // A new version that waits for photos is staged and hidden, so show the old one, which
    // now points at it.
    return (
      (row.deal_id && (await this.getDeal(userId, row.deal_id))) ||
      (await this.getDeal(userId, dealId)) ||
      "not_found"
    );
  }

  async withdrawCounter(
    userId: string,
    dealId: string,
    counterId: string,
  ): Promise<WithdrawCounterResult> {
    if (!(await this.#counterOf(counterId, dealId))) return "not_found";
    const { data, error } = await this.db.rpc("withdraw_counter", {
      p_user_id: userId,
      p_counter_id: counterId,
    });
    if (error) throw new RepositoryError("withdrawCounter", error);
    const { result } = z.object({ result: z.enum(["ok", "not_found", "closed"]) }).parse(data);
    if (result !== "ok") return result;
    return (await this.getDeal(userId, dealId)) ?? "not_found";
  }

  /** True when the counter belongs to that Deal, so a URL can't pair them up wrong. */
  async #counterOf(counterId: string, dealId: string): Promise<boolean> {
    if (!isUuid(counterId)) return false;
    const { data, error } = await this.db
      .from("deal_counters")
      .select("deal_id")
      .eq("id", counterId)
      .maybeSingle();
    if (error) throw new RepositoryError("counterOf", error);
    return (data as { deal_id: string } | null)?.deal_id === dealId;
  }

  async #memberCounts(circleIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (circleIds.length === 0) return counts;
    const { data, error } = await this.db
      .from("circle_members")
      .select("circle_id")
      .in("circle_id", circleIds);
    if (error) throw new RepositoryError("memberCounts", error);
    for (const r of z.array(z.object({ circle_id: z.string() })).parse(data ?? [])) {
      counts.set(r.circle_id, (counts.get(r.circle_id) ?? 0) + 1);
    }
    return counts;
  }

  async listTasteFacts(userId: string): Promise<TasteFactRecord[]> {
    const { data, error } = await this.db
      .from("taste_facts")
      .select(TASTE_FACT_SELECT)
      .eq("user_id", userId)
      .eq("status", "active")
      .order("always_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new RepositoryError("listTasteFacts", error);
    return z
      .array(TasteFactRow)
      .parse(data ?? [])
      .map((r) => ({
        id: r.id,
        userId: r.user_id,
        key: r.key,
        value: r.value,
        category: r.category,
        source: r.source,
        alwaysOn: r.always_on,
        status: r.status,
        createdAt: r.created_at,
      }));
  }

  async deleteTasteFact(userId: string, factId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("taste_facts")
      .update({ status: "deleted" })
      .eq("id", factId)
      .eq("user_id", userId)
      .select("id");
    if (error) throw new RepositoryError("deleteTasteFact", error);
    return (data ?? []).length > 0;
  }

  async #getItem(userId: string, itemId: string): Promise<ItemRecord | null> {
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_SELECT)
      .eq("id", itemId)
      .eq("owner_id", userId)
      .in("status", [...SHELF_STATUSES])
      .maybeSingle();
    if (error) throw new RepositoryError("getItem", error);
    return data ? toItem(ItemRow.parse(data)) : null;
  }

  async #counts(userId: string): Promise<MeRecord["counts"]> {
    const [items, asks, circles] = await Promise.all([
      this.db
        .from("items")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", userId)
        .in("status", [...SHELF_STATUSES]),
      this.db
        .from("asks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .in("status", ACTIVE_ASK_STATUSES),
      this.db
        .from("circle_members")
        .select("circle_id", { count: "exact", head: true })
        .eq("user_id", userId),
    ]);
    for (const res of [items, asks, circles]) {
      if (res.error) throw new RepositoryError("getMe.counts", res.error);
    }
    return {
      shelfItems: items.count ?? 0,
      activeAsks: asks.count ?? 0,
      circles: circles.count ?? 0,
    };
  }
}
