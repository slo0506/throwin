import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AutonomyLevel,
  ConditionGrade,
  DEFAULT_NOTIFICATION_PREFS,
  ItemStatus,
  ItemWillingness,
  NotificationPrefs,
} from "@throwin/shared";
import { z } from "zod";
import {
  ACTIVE_ASK_STATUSES,
  type CaptureMediaInput,
  type CaptureRecord,
  type CaptureStatus,
  type ItemRecord,
  type ItemUpdate,
  type MePatch,
  type MeRecord,
  type Repository,
  SHELF_STATUSES,
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
  follow_up: z.string().nullable(),
  appraising: z.boolean(),
  capture_id: z.string().nullable(),
  item_media: z.array(z.object({ storage_path: z.string(), position: z.number() })).nullable(),
  created_at: ts,
  updated_at: ts,
});

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
  const media = [...(r.item_media ?? [])].sort((a, b) => a.position - b.position);
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
    followUp: r.follow_up,
    appraising: r.appraising,
    captureId: r.capture_id,
    thumbnailPath: media[0]?.storage_path ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const USER_SELECT =
  "id, display_name, photo_url, created_at, deleted_at, profiles(autonomy_level, notification_prefs, home_area, default_handoff_place_id)";
const ITEM_SELECT =
  "id, owner_id, status, title, willingness, category, brand, model, variant, condition_grade, defects, value_low_cents, value_mid_cents, value_high_cents, identity_conf, condition_conf, reserved_by_deal_id, follow_up, appraising, capture_id, item_media(storage_path, position), created_at, updated_at";
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
      const { error } = await this.db
        .from("items")
        .update({ status: "on_shelf", follow_up: null })
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
