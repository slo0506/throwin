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
  type ItemRecord,
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
  created_at: ts,
  updated_at: ts,
});

const USER_SELECT =
  "id, display_name, photo_url, created_at, deleted_at, profiles(autonomy_level, notification_prefs, home_area, default_handoff_place_id)";
const ITEM_SELECT =
  "id, owner_id, status, title, willingness, category, brand, model, variant, condition_grade, defects, value_low_cents, value_mid_cents, value_high_cents, identity_conf, condition_conf, reserved_by_deal_id, created_at, updated_at";

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
      .map((r) => ({
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
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
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
