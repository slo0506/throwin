import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { MatchDeal } from "./matcher.js";
import type {
  ProspectingAsk,
  ProspectorStore,
  StageResult,
  StoredEdge,
  WantCandidate,
} from "./prospect.js";

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`${op}: ${error?.message ?? "unknown error"}`);
}

const AskRow = z.object({
  id: z.string(),
  user_id: z.string(),
  raw_text: z.string(),
  target: z.unknown(),
  ask_embeddings: z.array(z.object({ model: z.string(), source_hash: z.string() })).nullable(),
});

const CandidateRow = z.object({
  ask_id: z.string(),
  wanter_id: z.string(),
  cash_ceiling_cents: z.number().int(),
  item_id: z.string(),
  giver_id: z.string(),
  giver_ask_id: z.string(),
  similarity: z.number(),
  title: z.string(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  value_mid_cents: z.number().int(),
});

const StageRow = z.object({
  result: z.enum([
    "ok",
    "invalid",
    "ask_unavailable",
    "offer_changed",
    "over_ceiling",
    "items_taken",
  ]),
  deal_id: z.string().optional(),
});

/** The Prospector's database access with the service role. */
export class SupabaseProspectorStore implements ProspectorStore {
  constructor(private readonly db: SupabaseClient) {}

  async getAsk(userId: string, askId: string) {
    const { data, error } = await this.db
      .from("asks")
      .select("status")
      .eq("id", askId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("getAsk", error);
    return data ? { status: String((data as { status: unknown }).status) } : null;
  }

  async circlesOf(userId: string): Promise<string[]> {
    const { data, error } = await this.db
      .from("circle_members")
      .select("circle_id, circles!inner(status)")
      .eq("user_id", userId)
      .eq("circles.status", "active");
    if (error) fail("circlesOf", error);
    return ((data ?? []) as { circle_id: string }[]).map((r) => r.circle_id);
  }

  async prospectingAsks(circleIds: string[], model: string): Promise<ProspectingAsk[]> {
    const members = await this.db
      .from("circle_members")
      .select("user_id")
      .in("circle_id", circleIds);
    if (members.error) fail("prospectingAsks.members", members.error);
    const userIds = [
      ...new Set(((members.data ?? []) as { user_id: string }[]).map((m) => m.user_id)),
    ];
    if (userIds.length === 0) return [];
    const { data, error } = await this.db
      .from("asks")
      .select("id, user_id, raw_text, target, ask_embeddings(model, source_hash)")
      .eq("status", "prospecting")
      .in("user_id", userIds);
    if (error) fail("prospectingAsks", error);
    return z
      .array(AskRow)
      .parse(data ?? [])
      .map((r) => ({
        id: r.id,
        userId: r.user_id,
        rawText: r.raw_text,
        target: r.target,
        embeddingHash: r.ask_embeddings?.find((e) => e.model === model)?.source_hash ?? null,
      }));
  }

  async saveAskEmbedding(askId: string, model: string, vector: number[], hash: string) {
    const { error } = await this.db.from("ask_embeddings").upsert({
      ask_id: askId,
      model,
      embedding: JSON.stringify(vector),
      source_hash: hash,
      created_at: new Date().toISOString(),
    });
    if (error) fail("saveAskEmbedding", error);
  }

  async candidates(circleId: string, model: string, perAsk: number): Promise<WantCandidate[]> {
    const { data, error } = await this.db.rpc("circle_want_candidates", {
      p_circle_id: circleId,
      p_model: model,
      p_per_ask: perAsk,
    });
    if (error) fail("candidates", error);
    return z
      .array(CandidateRow)
      .parse(data ?? [])
      .map((r) => ({
        askId: r.ask_id,
        wanterId: r.wanter_id,
        cashCeilingCents: r.cash_ceiling_cents,
        itemId: r.item_id,
        giverId: r.giver_id,
        giverAskId: r.giver_ask_id,
        similarity: r.similarity,
        title: r.title,
        category: r.category,
        brand: r.brand,
        model: r.model,
        valueMidCents: r.value_mid_cents,
      }));
  }

  async replaceEdges(askIds: string[], edges: StoredEdge[]) {
    if (askIds.length > 0) {
      const { error } = await this.db.from("edges").delete().in("ask_id", askIds);
      if (error) fail("replaceEdges.delete", error);
    }
    if (edges.length === 0) return;
    const { error } = await this.db.from("edges").insert(
      edges.map((e) => ({
        from_user: e.fromUser,
        to_user: e.toUser,
        item_id: e.itemId,
        ask_id: e.askId,
        giver_ask_id: e.giverAskId,
        utility: e.utility,
        confidence: e.confidence,
        kind: "explicit",
      })),
    );
    if (error) fail("replaceEdges.insert", error);
  }

  async stageDeal(deal: MatchDeal): Promise<StageResult> {
    const { data, error } = await this.db.rpc("stage_deal", { p_deal: deal, p_mode: "live" });
    if (error) fail("stageDeal", error);
    const row = StageRow.parse(data);
    if (row.result !== "ok") return { result: row.result };
    if (!row.deal_id) fail("stageDeal", { message: "ok without a deal_id" });
    return { result: "ok", dealId: row.deal_id };
  }

  /** public.expire_deals: cancels open Deals past expiry. Returns how many. */
  async expireDeals(): Promise<number> {
    const { data, error } = await this.db.rpc("expire_deals");
    if (error) fail("expireDeals", error);
    return z.number().int().parse(data);
  }
}
