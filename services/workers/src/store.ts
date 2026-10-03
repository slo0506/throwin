import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelRun } from "./appraiser/claude.js";
import type { AppraiserStore, CaptureMedia, NewItem, Progress } from "./appraiser/pipeline.js";

const BUCKET = "item-media";
const toCents = (usd: number) => Math.round(usd * 100);

export interface Job {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`${op}: ${error?.message ?? "unknown error"}`);
}

/** Queue access through the claim_job and finish_job functions (service role only). */
export class SupabaseQueue {
  constructor(private readonly db: SupabaseClient) {}

  async claim(kinds: string[]): Promise<Job | null> {
    const { data, error } = await this.db.rpc("claim_job", { p_kinds: kinds });
    if (error) fail("claim_job", error);
    const rows = (data ?? []) as Job[];
    return rows[0] ?? null;
  }

  async finish(id: number, errorMessage?: string): Promise<void> {
    const { error } = await this.db.rpc("finish_job", { p_id: id, p_error: errorMessage ?? null });
    if (error) fail("finish_job", error);
  }
}

export class SupabaseAppraiserStore implements AppraiserStore {
  constructor(private readonly db: SupabaseClient) {}

  async loadCapture(captureId: string) {
    const { data, error } = await this.db
      .from("captures")
      .select("user_id, capture_media(storage_path, position, sharpness)")
      .eq("id", captureId)
      .maybeSingle();
    if (error) fail("loadCapture", error);
    if (!data) return null;
    const row = data as {
      user_id: string;
      capture_media: { storage_path: string; position: number; sharpness: number | null }[];
    };
    const media: CaptureMedia[] = row.capture_media.map((m) => ({
      path: m.storage_path,
      position: m.position,
      sharpness: m.sharpness,
    }));
    return { userId: row.user_id, media };
  }

  async clearCaptureItems(captureId: string): Promise<void> {
    const { error } = await this.db
      .from("items")
      .update({ status: "removed" })
      .eq("capture_id", captureId)
      .is("reserved_by_deal_id", null)
      .neq("status", "removed");
    if (error) fail("clearCaptureItems", error);
  }

  async download(path: string): Promise<Buffer> {
    const { data, error } = await this.db.storage.from(BUCKET).download(path);
    if (error || !data) fail(`download ${path}`, error);
    return Buffer.from(await data.arrayBuffer());
  }

  async upload(path: string, jpeg: Buffer): Promise<void> {
    const { error } = await this.db.storage
      .from(BUCKET)
      .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
    if (error) fail(`upload ${path}`, error);
  }

  async setProgress(captureId: string, progress: Progress): Promise<void> {
    const { error } = await this.db.from("captures").update({ progress }).eq("id", captureId);
    if (error) fail("setProgress", error);
  }

  async insertItem(item: NewItem): Promise<string> {
    const id = item.identification;
    const { data, error } = await this.db
      .from("items")
      .insert({
        owner_id: item.userId,
        capture_id: item.captureId,
        status: item.status,
        title: item.title.slice(0, 120),
        category: id.category,
        brand: id.brand,
        model: id.model,
        variant: id.variant,
        attributes: id.attributes,
        condition_grade: id.condition_grade,
        defects: id.defects,
        value_low_cents: item.value ? toCents(item.value.low_usd) : null,
        value_mid_cents: item.value ? toCents(item.value.mid_usd) : null,
        value_high_cents: item.value ? toCents(item.value.high_usd) : null,
        identity_conf: id.identity_confidence,
        condition_conf: id.condition_confidence,
        follow_up: id.follow_up,
      })
      .select("id")
      .single();
    if (error || !data) fail("insertItem", error);
    const itemId = (data as { id: string }).id;

    const media = await this.db.from("item_media").insert({
      item_id: itemId,
      storage_path: item.cropPath,
      kind: "photo",
      width: item.crop.width,
      height: item.crop.height,
      position: 0,
    });
    if (media.error) fail("insertItem.media", media.error);

    const appraisal = await this.db.from("appraisals").insert({
      item_id: itemId,
      model: "claude-sonnet-5-5",
      output: { identification: id, value: item.value },
      comps: item.comps,
    });
    if (appraisal.error) fail("insertItem.appraisal", appraisal.error);
    return itemId;
  }

  async saveEmbedding(itemId: string, model: string, vector: number[]): Promise<void> {
    const { error } = await this.db
      .from("item_embeddings")
      .upsert({ item_id: itemId, model, embedding: JSON.stringify(vector) });
    if (error) fail("saveEmbedding", error);
  }

  async finishCapture(captureId: string, itemCount: number, progress: Progress): Promise<void> {
    const { error } = await this.db
      .from("captures")
      .update({ status: "done", item_count: itemCount, progress })
      .eq("id", captureId);
    if (error) fail("finishCapture", error);
  }

  async failCapture(captureId: string, message: string): Promise<void> {
    const { error } = await this.db
      .from("captures")
      .update({ status: "failed", error: message, progress: { stage: "failed", detail: message } })
      .eq("id", captureId);
    if (error) fail("failCapture", error);
  }

  async recordRun(userId: string, run: ModelRun): Promise<void> {
    const { error } = await this.db.from("agent_runs").insert({
      agent: run.agent,
      trigger: "capture",
      user_id: userId,
      model: run.model,
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      cache_read_tokens: run.cacheReadTokens,
      cache_write_tokens: run.cacheWriteTokens,
      cost_cents: run.costCents,
      latency_ms: run.latencyMs,
      outcome: run.outcome,
    });
    if (error) fail("recordRun", error);
  }
}
