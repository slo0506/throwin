import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AskCardTarget,
  AskStatus,
  AutonomyLevel,
  ConditionGrade,
  ItemReadiness,
  ItemStatus,
  ItemWillingness,
} from "@throwin/shared";
import { z } from "zod";
import {
  ACTIVE_ASK_STATUSES,
  type AgentEvent,
  type AgentRun,
  type AskPatch,
  type AskRecord,
  type AskUpdateResult,
  type CircleStats,
  type Conversation,
  type GmData,
  type GmUser,
  type LoadedImage,
  type NetworkItem,
  type NetworkQuery,
  type NewAsk,
  type OwnItem,
  SHELF_STATUSES,
  type StoredMessage,
  type TasteFact,
} from "./data.js";

export const MEDIA_BUCKET = "item-media";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class GmDataError extends Error {
  constructor(operation: string, cause: { message: string; code?: string }) {
    super(`${operation} failed: ${cause.message}${cause.code ? ` (${cause.code})` : ""}`);
    this.name = "GmDataError";
  }
}

const ts = z.string().transform((s) => new Date(s));

const PatchAskResult = z.object({
  result: z.enum(["ok", "not_found", "ask_closed", "invalid_offer_item", "invalid_status"]),
});
const one = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema)]).transform((v) => (Array.isArray(v) ? v[0] : v));

const Media = z.array(z.object({ storage_path: z.string(), position: z.number() })).nullable();
const firstPhoto = (media: z.infer<typeof Media>) =>
  [...(media ?? [])].sort((a, b) => a.position - b.position)[0]?.storage_path ?? null;

const ITEM_SELECT =
  "id, owner_id, status, title, willingness, category, brand, model, variant, condition_grade, defects, value_low_cents, value_mid_cents, value_high_cents, identity_conf, condition_conf, reserved_by_deal_id, appraising, readiness, photo_score, photo_issues, missing_angles, description, item_media(storage_path, position), item_questions(prompt, impact, status), created_at, updated_at";

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
  readiness: ItemReadiness,
  photo_score: z.number().int().nullable(),
  photo_issues: z.array(z.string()).nullable(),
  missing_angles: z.array(z.string()).nullable(),
  description: z.string().nullable(),
  item_media: Media,
  item_questions: z
    .array(z.object({ prompt: z.string(), impact: z.number(), status: z.string() }))
    .nullable(),
  created_at: ts,
  updated_at: ts,
});

function toOwnItem(r: z.infer<typeof ItemRow>): OwnItem {
  const open = (r.item_questions ?? [])
    .filter((q) => q.status === "open")
    .sort((a, b) => b.impact - a.impact);
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
    reserved: r.reserved_by_deal_id !== null,
    appraising: r.appraising,
    readiness: r.readiness,
    photoScore: r.photo_score,
    photoIssues: r.photo_issues ?? [],
    missingAngles: r.missing_angles ?? [],
    description: r.description,
    openQuestions: open.length,
    followUp: open[0]?.prompt ?? null,
    thumbnailPath: firstPhoto(r.item_media),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const NETWORK_SELECT =
  "id, owner_id, title, category, brand, model, condition_grade, value_low_cents, value_mid_cents, value_high_cents, readiness, description, item_media(storage_path, position)";

const NetworkRow = z.object({
  id: z.string(),
  owner_id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  condition_grade: ConditionGrade.nullable(),
  value_low_cents: z.number().int().nullable(),
  value_mid_cents: z.number().int().nullable(),
  value_high_cents: z.number().int().nullable(),
  readiness: ItemReadiness,
  description: z.string().nullable(),
  item_media: Media,
});

const ASK_COLUMNS =
  "id, user_id, raw_text, title, target, status, cash_ceiling_cents, deadline, autonomy, created_at, updated_at, offer_sets(item_id)";

const AskRow = z.object({
  id: z.string(),
  user_id: z.string(),
  raw_text: z.string(),
  title: z.string().nullable(),
  target: z.unknown(),
  status: AskStatus,
  cash_ceiling_cents: z.number().int(),
  deadline: ts.nullable(),
  autonomy: AutonomyLevel,
  created_at: ts,
  updated_at: ts,
  offer_sets: z.array(z.object({ item_id: z.string() })).nullable(),
});

function toAsk(r: z.infer<typeof AskRow>): AskRecord {
  const target = AskCardTarget.safeParse(r.target);
  return {
    id: r.id,
    userId: r.user_id,
    rawText: r.raw_text,
    title: r.title,
    status: r.status,
    target: target.success ? target.data : null,
    cashCeilingCents: r.cash_ceiling_cents,
    deadline: r.deadline,
    autonomy: r.autonomy,
    offerItemIds: (r.offer_sets ?? []).map((o) => o.item_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const MessageRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.array(z.record(z.string(), z.unknown())),
  tool_calls: z.unknown(),
  created_at: ts,
});

/** Letters, digits and spaces only, so a query can never reach PostgREST filter syntax. */
const searchWords = (q: string | undefined) =>
  (q ?? "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 5);

const isUuid = (id: string) => z.uuid().safeParse(id).success;

function sniffImage(bytes: Uint8Array): LoadedImage["mediaType"] | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/**
 * GmData on Supabase with the service role. The service role bypasses row-level security,
 * so every query filters by the acting user explicitly. Network reads mirror the
 * `network_items` security-definer function (which keys on auth.uid() and so cannot run
 * under the service role), plus the showcase rule.
 */
export class SupabaseGmData implements GmData {
  constructor(private readonly db: SupabaseClient) {}

  async getUser(userId: string): Promise<GmUser | null> {
    const { data, error } = await this.db
      .from("users")
      .select("id, display_name, deleted_at, profiles(autonomy_level)")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new GmDataError("getUser", error);
    if (!data) return null;
    const row = z
      .object({
        id: z.string(),
        display_name: z.string().nullable(),
        deleted_at: z.string().nullable(),
        profiles: one(z.object({ autonomy_level: AutonomyLevel })).nullable(),
      })
      .parse(data);
    if (row.deleted_at) return null;
    const first = row.display_name?.trim().split(/\s+/)[0] ?? null;
    return {
      id: row.id,
      firstName: first || null,
      autonomy: row.profiles?.autonomy_level ?? "every_deal",
    };
  }

  async listShelfItems(userId: string): Promise<OwnItem[]> {
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_SELECT)
      .eq("owner_id", userId)
      .in("status", [...SHELF_STATUSES])
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new GmDataError("listShelfItems", error);
    return z
      .array(ItemRow)
      .parse(data ?? [])
      .map(toOwnItem);
  }

  async getOwnItems(userId: string, ids: string[]): Promise<OwnItem[]> {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return [];
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_SELECT)
      .eq("owner_id", userId)
      .in("id", valid)
      .in("status", [...SHELF_STATUSES]);
    if (error) throw new GmDataError("getOwnItems", error);
    return z
      .array(ItemRow)
      .parse(data ?? [])
      .map(toOwnItem);
  }

  async setItemWillingness(
    userId: string,
    itemId: string,
    willingness: z.infer<typeof ItemWillingness>,
  ) {
    if (!isUuid(itemId)) return null;
    const { error } = await this.db
      .from("items")
      .update({ willingness })
      .eq("id", itemId)
      .eq("owner_id", userId)
      .in("status", [...SHELF_STATUSES]);
    if (error) throw new GmDataError("setItemWillingness", error);
    const [item] = await this.getOwnItems(userId, [itemId]);
    return item ?? null;
  }

  /** Members who share a Circle with the user, minus blocks either way and deleted users. */
  async #coMembers(userId: string): Promise<{ circles: number; names: Map<string, string> }> {
    const mine = await this.db.from("circle_members").select("circle_id").eq("user_id", userId);
    if (mine.error) throw new GmDataError("coMembers.mine", mine.error);
    const circleIds = (mine.data ?? []).map((r) => (r as { circle_id: string }).circle_id);
    if (circleIds.length === 0) return { circles: 0, names: new Map() };

    const [members, blocks] = await Promise.all([
      this.db
        .from("circle_members")
        .select("user_id")
        .in("circle_id", circleIds)
        .neq("user_id", userId),
      this.db
        .from("blocks")
        .select("blocker_id, blocked_id")
        .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    ]);
    if (members.error) throw new GmDataError("coMembers.members", members.error);
    if (blocks.error) throw new GmDataError("coMembers.blocks", blocks.error);
    const blocked = new Set(
      (blocks.data ?? []).flatMap((b) => {
        const row = b as { blocker_id: string; blocked_id: string };
        return [row.blocker_id, row.blocked_id];
      }),
    );
    const ids = [
      ...new Set((members.data ?? []).map((m) => (m as { user_id: string }).user_id)),
    ].filter((id) => !blocked.has(id));
    if (ids.length === 0) return { circles: circleIds.length, names: new Map() };

    const users = await this.db
      .from("users")
      .select("id, display_name")
      .in("id", ids)
      .is("deleted_at", null);
    if (users.error) throw new GmDataError("coMembers.users", users.error);
    const names = new Map<string, string>();
    for (const u of users.data ?? []) {
      const row = u as { id: string; display_name: string | null };
      names.set(row.id, row.display_name?.trim().split(/\s+/)[0] || "A member");
    }
    return { circles: circleIds.length, names };
  }

  async listNetworkItems(userId: string, query: NetworkQuery): Promise<NetworkItem[]> {
    const { names } = await this.#coMembers(userId);
    if (names.size === 0) return [];
    let q = this.db
      .from("items")
      .select(NETWORK_SELECT)
      .in("owner_id", [...names.keys()])
      .eq("status", "on_shelf")
      .eq("readiness", "showcase")
      .neq("willingness", "not_available")
      .order("updated_at", { ascending: false })
      .limit(query.limit);
    if (query.ids) {
      const ids = query.ids.filter(isUuid);
      if (ids.length === 0) return [];
      q = q.in("id", ids);
    }
    const words = searchWords(query.query);
    if (words.length) {
      q = q.or(
        words
          .flatMap((w) =>
            ["title", "brand", "model", "category"].map((col) => `${col}.ilike.%${w}%`),
          )
          .join(","),
      );
    }
    const { data, error } = await q;
    if (error) throw new GmDataError("listNetworkItems", error);
    return z
      .array(NetworkRow)
      .parse(data ?? [])
      .map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        ownerFirstName: names.get(r.owner_id) ?? "A member",
        title: r.title,
        category: r.category,
        brand: r.brand,
        model: r.model,
        conditionGrade: r.condition_grade,
        valueLowCents: r.value_low_cents,
        valueMidCents: r.value_mid_cents,
        valueHighCents: r.value_high_cents,
        readiness: r.readiness,
        description: r.description,
        thumbnailPath: firstPhoto(r.item_media),
      }));
  }

  async circleStats(userId: string): Promise<CircleStats> {
    const { circles, names } = await this.#coMembers(userId);
    return { circles, shelves: names.size };
  }

  async listActiveAsks(userId: string): Promise<AskRecord[]> {
    const { data, error } = await this.db
      .from("asks")
      .select(ASK_COLUMNS)
      .eq("user_id", userId)
      .in("status", [...ACTIVE_ASK_STATUSES])
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new GmDataError("listActiveAsks", error);
    return z
      .array(AskRow)
      .parse(data ?? [])
      .map(toAsk);
  }

  async setAutonomy(userId: string, level: AutonomyLevel): Promise<void> {
    const profile = await this.db
      .from("profiles")
      .update({ autonomy_level: level })
      .eq("user_id", userId);
    if (profile.error) throw new GmDataError("setAutonomy.profile", profile.error);
    const asks = await this.db
      .from("asks")
      .update({ autonomy: level })
      .eq("user_id", userId)
      .in("status", [...ACTIVE_ASK_STATUSES]);
    if (asks.error) throw new GmDataError("setAutonomy.asks", asks.error);
  }

  async getAsk(userId: string, askId: string): Promise<AskRecord | null> {
    if (!isUuid(askId)) return null;
    const { data, error } = await this.db
      .from("asks")
      .select(ASK_COLUMNS)
      .eq("id", askId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new GmDataError("getAsk", error);
    return data ? toAsk(AskRow.parse(data)) : null;
  }

  async createAsk(userId: string, ask: NewAsk): Promise<AskRecord> {
    const { data, error } = await this.db
      .from("asks")
      .insert({
        user_id: userId,
        raw_text: ask.rawText,
        target: ask.target ?? {},
        status: ask.status,
        autonomy: ask.autonomy,
        deadline: ask.deadline?.toISOString() ?? null,
        title: ask.title,
      })
      .select("id")
      .single();
    if (error) throw new GmDataError("createAsk", error);
    const created = await this.getAsk(userId, (data as { id: string }).id);
    if (!created) throw new GmDataError("createAsk", { message: "created Ask not found" });
    return created;
  }

  async updateAsk(userId: string, askId: string, patch: AskPatch): Promise<AskUpdateResult> {
    if (!isUuid(askId)) return "not_found";
    if (patch.offerItemIds?.some((id) => !isUuid(id))) return "invalid_offer_item";
    const fields: Record<string, unknown> = {
      ...(patch.rawText !== undefined && { raw_text: patch.rawText }),
      ...(patch.target !== undefined && { target: patch.target ?? {} }),
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.offerItemIds !== undefined && { offer_item_ids: patch.offerItemIds }),
      ...(patch.cashCeilingCents !== undefined && { cash_ceiling_cents: patch.cashCeilingCents }),
      ...(patch.autonomy !== undefined && { autonomy: patch.autonomy }),
      ...(patch.deadline !== undefined && { deadline: patch.deadline?.toISOString() ?? null }),
    };
    const { data, error } = await this.db.rpc("patch_ask", {
      p_user_id: userId,
      p_ask_id: askId,
      p_patch: fields,
    });
    if (error) throw new GmDataError("updateAsk", error);
    const { result } = PatchAskResult.parse(data);
    // AskPatch has no status field, so invalid_status means a bug here.
    if (result === "invalid_status") throw new GmDataError("updateAsk", { message: result });
    if (result !== "ok") return result;
    return (await this.getAsk(userId, askId)) ?? "not_found";
  }

  async listAlwaysOnFacts(userId: string): Promise<TasteFact[]> {
    const { data, error } = await this.db
      .from("taste_facts")
      .select("id, key, value, category")
      .eq("user_id", userId)
      .eq("status", "active")
      .eq("always_on", true)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw new GmDataError("listAlwaysOnFacts", error);
    return z
      .array(z.object({ id: z.string(), key: z.string(), value: z.string(), category: z.string() }))
      .parse(data ?? []);
  }

  async latestConversation(userId: string): Promise<Conversation | null> {
    const { data, error } = await this.db
      .from("conversations")
      .select("id, user_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new GmDataError("latestConversation", error);
    if (!data) return null;
    const row = data as { id: string; user_id: string; created_at: string };
    return { id: row.id, userId: row.user_id, createdAt: new Date(row.created_at) };
  }

  async createConversation(userId: string): Promise<Conversation> {
    const { data, error } = await this.db
      .from("conversations")
      .insert({ user_id: userId })
      .select("id, user_id, created_at")
      .single();
    if (error) throw new GmDataError("createConversation", error);
    const row = data as { id: string; user_id: string; created_at: string };
    return { id: row.id, userId: row.user_id, createdAt: new Date(row.created_at) };
  }

  async listMessages(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from("messages")
      .select("id, conversation_id, user_id, role, content, tool_calls, created_at")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new GmDataError("listMessages", error);
    return z
      .array(MessageRow)
      .parse(data ?? [])
      .reverse()
      .map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        userId: r.user_id,
        role: r.role,
        content: r.content as unknown as Anthropic.ContentBlockParam[],
        toolCalls: r.tool_calls ?? null,
        createdAt: r.created_at,
      }));
  }

  async appendMessages(rows: StoredMessage[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db.from("messages").insert(
      rows.map((r) => ({
        id: r.id,
        conversation_id: r.conversationId,
        user_id: r.userId,
        role: r.role,
        content: r.content,
        tool_calls: r.toolCalls ?? null,
        created_at: r.createdAt.toISOString(),
      })),
    );
    if (error) throw new GmDataError("appendMessages", error);
    const touched = await this.db
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", rows[0]?.conversationId as string);
    if (touched.error) throw new GmDataError("appendMessages.touch", touched.error);
  }

  async intakeFinished(userId: string, conversationId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("messages")
      .select("id")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .contains("tool_calls", { calls: [{ name: "finish_intake", ok: true }] })
      .limit(1);
    if (error) throw new GmDataError("intakeFinished", error);
    return (data ?? []).length > 0;
  }

  async recordRun(run: AgentRun): Promise<void> {
    const { error } = await this.db.from("agent_runs").insert({
      id: run.id,
      agent: run.agent,
      trigger: run.trigger,
      user_id: run.userId,
      ask_id: run.askId,
      model: run.model,
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      cache_read_tokens: run.cacheReadTokens,
      cache_write_tokens: run.cacheWriteTokens,
      cost_cents: run.costCents,
      latency_ms: run.latencyMs,
      outcome: run.outcome,
    });
    if (error) throw new GmDataError("recordRun", error);
  }

  async recordEvents(events: AgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    const { error } = await this.db.from("agent_events").insert(
      events.map((e) => ({
        run_id: e.runId,
        user_id: e.userId,
        type: e.type,
        user_visible: e.userVisible,
        summary: e.summary,
        payload: e.payload,
      })),
    );
    if (error) throw new GmDataError("recordEvents", error);
  }

  async enqueueJob(kind: string, payload: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from("jobs").insert({ kind, payload });
    if (error) throw new GmDataError("enqueueJob", error);
  }

  async signedUrls(paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (paths.length === 0) return out;
    const { data, error } = await this.db.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600);
    if (error) throw new GmDataError("signedUrls", error);
    for (const row of data ?? []) {
      if (row.path) out.set(row.path, row.signedUrl ?? null);
    }
    return out;
  }

  async loadImage(userId: string, path: string): Promise<LoadedImage | null> {
    if (!path.startsWith(`${userId}/`) || path.includes("..")) return null;
    const { data, error } = await this.db.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) return null;
    if (data.size > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    const mediaType = sniffImage(bytes);
    if (!mediaType) return null;
    return { mediaType, base64: Buffer.from(bytes).toString("base64") };
  }
}
