import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AskStatus,
  AskTarget,
  AutonomyLevel,
  ConditionGrade,
  compareQuestions,
  DEFAULT_NOTIFICATION_PREFS,
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
  type AnswerInput,
  type AnswerResult,
  type AskInsert,
  type AskRecord,
  type AskUpdate,
  type AskUpdateResult,
  type CaptureMediaInput,
  type CaptureRecord,
  type CaptureStatus,
  type ItemRecord,
  type ItemUpdate,
  type MePatch,
  type MeRecord,
  type QuestionRecord,
  type Repository,
  SHELF_STATUSES,
  type TasteFactRecord,
} from "./types.js";

const ts = z.string().transform((s) => new Date(s));

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

const firstPhoto = (media: { storage_path: string; position: number }[] | null) =>
  [...(media ?? [])].sort((a, b) => a.position - b.position)[0]?.storage_path ?? null;

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
  "id, user_id, raw_text, title, status, target, cash_ceiling_cents, autonomy, deadline, created_at, updated_at, offer_sets(item_id, items(status, value_low_cents, value_high_cents))";
const TASTE_FACT_SELECT =
  "id, user_id, key, value, category, source, always_on, status, created_at";

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
