import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuestionKind, QuestionStatus } from "@throwin/shared";
import type { ModelRun } from "./appraiser/claude.js";
import type { PreparedImage } from "./appraiser/images.js";
import type {
  AppraiserStore,
  CaptureMedia,
  NewItem,
  PricedItem,
  Progress,
  ReappraisedItem,
  StoredItem,
} from "./appraiser/pipeline.js";
import type { CachedPrice } from "./appraiser/price-cache.js";
import { PROMPT_VERSION } from "./appraiser/prompts.js";
import type { Identification, ValueEstimate } from "./appraiser/schemas.js";
import { REFINER_PROMPT_VERSION } from "./refiner/prompts.js";
import type { RefineItem, RefinementUpdate, RefineReason, RefinerStore } from "./refiner/refine.js";

const BUCKET = "item-media";
const toCents = (usd: number) => Math.round(usd * 100);
const DAY_MS = 86_400_000;

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

/** The identification columns of an Item, as written by the Appraiser. */
function identificationColumns(id: Identification) {
  return {
    title: id.title.slice(0, 120),
    category: id.category,
    brand: id.brand,
    model: id.model,
    variant: id.variant,
    attributes: id.attributes,
    condition_grade: id.condition_grade,
    defects: id.defects,
    identity_conf: id.identity_confidence,
    condition_conf: id.condition_confidence,
    follow_up: id.follow_up,
  };
}

function valueColumns(value: ValueEstimate | null) {
  return {
    value_low_cents: value ? toCents(value.low_usd) : null,
    value_mid_cents: value ? toCents(value.mid_usd) : null,
    value_high_cents: value ? toCents(value.high_usd) : null,
  };
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
  constructor(protected readonly db: SupabaseClient) {}

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
      .update({ status: "removed", appraising: false })
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
    const { data, error } = await this.db
      .from("items")
      .insert({
        owner_id: item.userId,
        capture_id: item.captureId,
        status: item.status,
        appraising: true,
        ...identificationColumns({ ...item.identification, title: item.title }),
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
      // Frame position, box normalized to that frame, and "refined" or "detector".
      crop_box: item.cropBox,
    });
    if (media.error) fail("insertItem.media", media.error);
    return itemId;
  }

  async finishItem(itemId: string, priced: PricedItem): Promise<void> {
    await this.appendAppraisal(itemId, priced.identification, priced, []);
    const { error } = await this.db
      .from("items")
      .update({ ...valueColumns(priced.value), appraising: false })
      .eq("id", itemId);
    if (error) fail("finishItem", error);
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
    const items = await this.db
      .from("items")
      .update({ appraising: false })
      .eq("capture_id", captureId)
      .eq("appraising", true);
    if (items.error) fail("failCapture.items", items.error);
  }

  async recordRun(userId: string, run: ModelRun, trigger = "capture"): Promise<void> {
    const { error } = await this.db.from("agent_runs").insert({
      agent: run.agent,
      trigger,
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

  async getCachedPrice(
    key: string,
    grade: Identification["condition_grade"],
    maxAgeDays: number,
  ): Promise<CachedPrice | null> {
    const { data, error } = await this.db
      .from("price_cache")
      .select(
        "value_low_cents, value_mid_cents, value_high_cents, confidence, basis, research, model",
      )
      .eq("product_key", key)
      .eq("condition_grade", grade)
      .gte("created_at", new Date(Date.now() - maxAgeDays * DAY_MS).toISOString())
      .maybeSingle();
    if (error) fail("getCachedPrice", error);
    if (!data) return null;
    const row = data as {
      value_low_cents: number;
      value_mid_cents: number;
      value_high_cents: number;
      confidence: number;
      basis: unknown;
      research: string;
      model: string;
    };
    return {
      lowCents: row.value_low_cents,
      midCents: row.value_mid_cents,
      highCents: row.value_high_cents,
      confidence: row.confidence,
      basis: Array.isArray(row.basis) ? row.basis.map(String) : [],
      research: row.research,
      model: row.model,
    };
  }

  async putCachedPrice(
    key: string,
    grade: Identification["condition_grade"],
    price: CachedPrice,
  ): Promise<void> {
    const { error } = await this.db.from("price_cache").upsert({
      product_key: key,
      condition_grade: grade,
      value_low_cents: price.lowCents,
      value_mid_cents: price.midCents,
      value_high_cents: price.highCents,
      confidence: price.confidence,
      basis: price.basis,
      research: price.research,
      model: price.model,
      prompt_version: PROMPT_VERSION,
      created_at: new Date().toISOString(),
    });
    if (error) fail("putCachedPrice", error);
  }

  async loadItem(itemId: string, userId: string): Promise<StoredItem | null> {
    const { data, error } = await this.db
      .from("items")
      .select(
        "id, owner_id, appraising, title, category, brand, model, variant, attributes, condition_grade, defects, identity_conf, condition_conf, follow_up, value_mid_cents, item_media(id, storage_path, position, created_at)",
      )
      .eq("id", itemId)
      .eq("owner_id", userId)
      .neq("status", "removed")
      .maybeSingle();
    if (error) fail("loadItem", error);
    if (!data) return null;
    const row = data as {
      id: string;
      owner_id: string;
      appraising: boolean;
      title: string;
      category: string | null;
      brand: string | null;
      model: string | null;
      variant: string | null;
      attributes: Record<string, string> | null;
      condition_grade: Identification["condition_grade"] | null;
      defects: string[] | null;
      identity_conf: number | null;
      condition_conf: number | null;
      follow_up: string | null;
      value_mid_cents: number | null;
      item_media: { id: string; storage_path: string; position: number; created_at: string }[];
    };
    return {
      id: row.id,
      userId: row.owner_id,
      appraising: row.appraising,
      hasValue: row.value_mid_cents !== null,
      identification: {
        is_tradeable_item: true,
        title: row.title,
        category: row.category ?? "other",
        brand: row.brand,
        model: row.model,
        variant: row.variant,
        attributes: row.attributes ?? {},
        condition_grade: row.condition_grade ?? "C",
        defects: row.defects ?? [],
        age_estimate_years: null,
        identity_confidence: row.identity_conf ?? 0,
        condition_confidence: row.condition_conf ?? 0,
        follow_up: row.follow_up,
      },
      media: (row.item_media ?? []).map((m) => ({
        id: m.id,
        path: m.storage_path,
        position: m.position,
        createdAt: new Date(m.created_at),
      })),
    };
  }

  async saveReappraisal(itemId: string, update: ReappraisedItem): Promise<void> {
    await this.appendAppraisal(itemId, update.identification, update.priced, update.inputMediaIds);
    const fields = {
      ...identificationColumns(update.identification),
      ...(update.priced && valueColumns(update.priced.value)),
      appraising: false,
    };
    const { error } = await this.db.from("items").update(fields).eq("id", itemId);
    if (error) fail("saveReappraisal", error);
    // A Deal may have reserved the Item meanwhile; never move it out of reserved.
    const status = await this.db
      .from("items")
      .update({ status: update.status })
      .eq("id", itemId)
      .is("reserved_by_deal_id", null)
      .in("status", ["draft", "needs_photos", "on_shelf"]);
    if (status.error) fail("saveReappraisal.status", status.error);
  }

  async addHero(itemId: string, path: string, image: PreparedImage): Promise<void> {
    const { data, error } = await this.db
      .from("item_media")
      .select("id, position")
      .eq("item_id", itemId);
    if (error) fail("addHero.read", error);
    // Shift from the back so positions stay unique at every step.
    const rows = ((data ?? []) as { id: string; position: number }[]).sort(
      (a, b) => b.position - a.position,
    );
    for (const row of rows) {
      const shift = await this.db
        .from("item_media")
        .update({ position: row.position + 1 })
        .eq("id", row.id);
      if (shift.error) fail("addHero.shift", shift.error);
    }
    const insert = await this.db.from("item_media").insert({
      item_id: itemId,
      storage_path: path,
      kind: "photo",
      width: image.width,
      height: image.height,
      position: 0,
    });
    if (insert.error) fail("addHero.insert", insert.error);
  }

  async setAppraising(itemId: string, appraising: boolean): Promise<void> {
    const { error } = await this.db.from("items").update({ appraising }).eq("id", itemId);
    if (error) fail("setAppraising", error);
  }

  protected async appendAppraisal(
    itemId: string,
    identification: Identification,
    priced: PricedItem | undefined,
    inputMediaIds: string[],
    source: { model: string; promptVersion: string; extra?: Record<string, unknown> } = {
      model: "claude-sonnet-5-5",
      promptVersion: PROMPT_VERSION,
    },
  ) {
    const { error } = await this.db.from("appraisals").insert({
      item_id: itemId,
      // Identification model; the pricing model is recorded in output.price_model.
      model: source.model,
      input_media_ids: inputMediaIds,
      output: {
        prompt_version: source.promptVersion,
        identification,
        ...(priced && { value: priced.value, price_model: priced.model }),
        ...source.extra,
      },
      comps: priced?.comps ?? [],
    });
    if (error) fail("appendAppraisal", error);
  }

  /** Queues a Refiner pass unless 1 is already waiting for this Item. */
  async enqueueRefine(itemId: string, userId: string, reason: RefineReason): Promise<void> {
    const { error } = await this.db.rpc("enqueue_refine_item", {
      p_item_id: itemId,
      p_user_id: userId,
      p_reason: reason,
    });
    if (error) fail("enqueueRefine", error);
  }
}

const QUESTION_SELECT =
  "id, kind, prompt, options, driver, impact, status, skip_count, answer, folded_at, created_at, answered_at";

interface QuestionRow {
  id: string;
  kind: QuestionKind;
  prompt: string;
  options: unknown;
  driver: string;
  impact: number;
  status: QuestionStatus;
  skip_count: number;
  answer: { value?: unknown } | null;
  folded_at: string | null;
  created_at: string;
  answered_at: string | null;
}

const date = (v: string | null) => (v ? new Date(v) : null);

/** The Refiner's reads and writes. Shares downloads, runs and the price cache with the Appraiser. */
export class SupabaseRefinerStore extends SupabaseAppraiserStore implements RefinerStore {
  async loadForRefine(itemId: string, userId: string): Promise<RefineItem | null> {
    const stored = await this.loadItem(itemId, userId);
    if (!stored) return null;
    const { data, error } = await this.db
      .from("items")
      .select(
        `identity_confirmed, value_low_cents, value_mid_cents, value_high_cents, description, photo_score, missing_angles, researched_at, item_questions(${QUESTION_SELECT})`,
      )
      .eq("id", itemId)
      .maybeSingle();
    if (error) fail("loadForRefine", error);
    if (!data) return null;
    const row = data as {
      identity_confirmed: boolean;
      value_low_cents: number | null;
      value_mid_cents: number | null;
      value_high_cents: number | null;
      description: string | null;
      photo_score: number | null;
      missing_angles: string[] | null;
      researched_at: string | null;
      item_questions: QuestionRow[] | null;
    };
    const hasValue =
      row.value_low_cents !== null && row.value_mid_cents !== null && row.value_high_cents !== null;
    return {
      id: stored.id,
      userId: stored.userId,
      identification: stored.identification,
      identityConfirmed: row.identity_confirmed,
      value: hasValue
        ? {
            lowCents: row.value_low_cents as number,
            midCents: row.value_mid_cents as number,
            highCents: row.value_high_cents as number,
          }
        : null,
      description: row.description,
      photoScore: row.photo_score,
      missingAngles: row.missing_angles ?? [],
      researchedAt: date(row.researched_at),
      media: stored.media.map((m) => ({ id: m.id, path: m.path, position: m.position })),
      questions: (row.item_questions ?? []).map((q) => ({
        id: q.id,
        kind: q.kind,
        prompt: q.prompt,
        options: Array.isArray(q.options) ? q.options.map(String) : [],
        driver: q.driver,
        impact: q.impact,
        status: q.status,
        skipCount: q.skip_count,
        answer: typeof q.answer?.value === "string" ? q.answer.value : null,
        foldedAt: date(q.folded_at),
        createdAt: new Date(q.created_at),
        answeredAt: date(q.answered_at),
      })),
    };
  }

  async saveRefinement(itemId: string, update: RefinementUpdate): Promise<void> {
    const now = new Date().toISOString();
    if (update.foldedQuestionIds.length > 0) {
      const { error } = await this.db
        .from("item_questions")
        .update({ folded_at: now })
        .in("id", update.foldedQuestionIds);
      if (error) fail("saveRefinement.fold", error);
    }
    if (update.closeOpenQuestions) {
      const { error } = await this.db
        .from("item_questions")
        .delete()
        .eq("item_id", itemId)
        .eq("status", "open");
      if (error) fail("saveRefinement.close", error);
    }
    for (const q of update.newQuestions) {
      const { error } = await this.db.from("item_questions").insert({ item_id: itemId, ...q });
      // 23505: a question for this driver opened meanwhile. Keep that one.
      if (error && error.code !== "23505") fail("saveRefinement.question", error);
    }
    if (update.identification || update.priced) {
      await this.appendAppraisal(
        itemId,
        update.identification ?? (update.priced as PricedItem).identification,
        update.priced,
        [],
        {
          model: "claude-haiku-4-5",
          promptVersion: REFINER_PROMPT_VERSION,
          extra: { source: "refiner" },
        },
      );
    }

    const fields: Record<string, unknown> = {
      ...(update.identification && identificationColumns(update.identification)),
      ...(update.priced && valueColumns(update.priced.value)),
      ...(update.identityConfirmed !== undefined && {
        identity_confirmed: update.identityConfirmed,
      }),
      ...(update.description !== undefined && { description: update.description }),
      ...(update.photo && {
        photo_score: update.photo.score,
        photo_issues: update.photo.issues,
        missing_angles: update.photo.missingAngles,
      }),
      ...(update.researchedAt && { researched_at: update.researchedAt.toISOString() }),
    };
    // Answers given while this pass ran wait for their own pass, so stay appraising.
    const waiting = await this.db
      .from("item_questions")
      .select("id", { count: "exact", head: true })
      .eq("item_id", itemId)
      .eq("status", "answered")
      .is("folded_at", null);
    if (waiting.error) fail("saveRefinement.waiting", waiting.error);
    fields.appraising = (waiting.count ?? 0) > 0;
    const { error } = await this.db.from("items").update(fields).eq("id", itemId);
    if (error) fail("saveRefinement", error);
  }
}
