import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { ClaudeVision, type ModelRun, type PricingConfig } from "./appraiser/claude.js";
import { VoyageEmbedder } from "./appraiser/embeddings.js";
import { type AppraiserDeps, appraiseCapture, reappraiseItem } from "./appraiser/pipeline.js";
import { CachedPricer } from "./appraiser/price-cache.js";
import { SpendGuard } from "./budget.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./log.js";
import { ExtractMemoryPayload, extractMemory } from "./memory/extract.js";
import { ClaudeMemoryModel } from "./memory/model.js";
import { SupabaseMemoryStore } from "./memory/store.js";
import { HttpMatcher } from "./prospector/matcher.js";
import { type ProspectorDeps, prospectAsk, prospectCircle } from "./prospector/prospect.js";
import { ClaudeReviewModel } from "./prospector/review.js";
import { SupabaseProspectorStore } from "./prospector/store.js";
import { ClaudeRefinerModels } from "./refiner/models.js";
import {
  type RefineReason,
  type RefinerConfig,
  type RefinerDeps,
  refineItem,
} from "./refiner/refine.js";
import { type Job, SupabaseQueue, SupabaseRefinerStore } from "./store.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const queue = new SupabaseQueue(db);
const budget = new SpendGuard(
  (since) => queue.spentSince(since),
  env.WORKER_DAILY_BUDGET_CENTS,
  logger,
);
// The Refiner's store is the Appraiser's plus questions, so 1 instance serves both.
const store = new SupabaseRefinerStore(db);
const memoryStore = new SupabaseMemoryStore(db);
const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  maxRetries: env.ANTHROPIC_MAX_RETRIES,
});
const embedder = new VoyageEmbedder(env.VOYAGE_API_KEY);
const pricing: PricingConfig = {
  researchModel: env.PRICE_RESEARCH_MODEL,
  fallbackModel: env.PRICE_FALLBACK_MODEL,
  fallbackBelow: env.PRICE_FALLBACK_BELOW,
  maxSearches: env.PRICE_MAX_SEARCHES,
  researchMaxTokens: env.PRICE_RESEARCH_MAX_TOKENS,
};
const pipeline = { parallelIdentify: env.PARALLEL_IDENTIFY, parallelPricing: env.PARALLEL_PRICING };
const refiner: RefinerConfig = {
  maxOpenQuestions: env.REFINER_MAX_OPEN_QUESTIONS,
  research: env.REFINER_RESEARCH,
  researchMinMidCents: env.REFINER_RESEARCH_MIN_MID_CENTS,
  researchCooldownHours: env.REFINER_RESEARCH_COOLDOWN_HOURS,
  reaskAfterHours: env.REFINER_REASK_AFTER_HOURS,
  photo: { sharpnessLow: env.REFINER_SHARPNESS_LOW, sharpnessHigh: env.REFINER_SHARPNESS_HIGH },
};

const prospectorStore = new SupabaseProspectorStore(db);
const prospector: Omit<ProspectorDeps, "review"> | null = env.MATCHER_URL
  ? {
      store: prospectorStore,
      embedder,
      matcher: new HttpMatcher(env.MATCHER_URL),
      config: {
        minSimilarity: env.PROSPECT_MIN_SIMILARITY,
        candidatesPerAsk: env.PROSPECT_CANDIDATES_PER_ASK,
        maxEmbedsPerRun: env.PROSPECT_MAX_EMBEDS,
        matcherTimeLimitSeconds: env.MATCHER_TIME_LIMIT_SECONDS,
        maxItemsPerLeg: env.PROSPECT_MAX_ITEMS_PER_LEG,
      },
      logger,
    }
  : null;

const KINDS = [
  "appraise_capture",
  "reappraise_item",
  "refine_item",
  "extract_memory",
  // Without a matcher, these stay queued until one is configured.
  ...(prospector ? ["prospect_ask", "drop_circle"] : []),
];
const REASONS: readonly RefineReason[] = ["created", "answer", "photos"];
let stopping = false;

/** Records a job's model runs against its user (none for a whole-Circle drop) and trigger. */
function recorder(userId: string | null, trigger: string, runs: Promise<void>[]) {
  return (run: ModelRun) => {
    runs.push(
      store
        .recordRun(userId, run, trigger)
        .catch((err) => logger.warn("record_run_failed", { error: String(err) })),
    );
  };
}

/** Per-job dependencies: model runs are attributed to the job's user and trigger. */
function depsFor(userId: string, trigger: string, runs: Promise<void>[]) {
  const onRun = recorder(userId, trigger, runs);
  const vision = new ClaudeVision(anthropic, onRun, pricing, { detectGrid: env.DETECT_GRID });
  const pricer = new CachedPricer(
    vision,
    store,
    { ttlDays: env.PRICE_CACHE_TTL_DAYS, minConfidence: env.PRICE_CACHE_MIN_CONFIDENCE },
    (op, err) => logger.warn(op, { error: String(err) }),
  );
  const appraiser: AppraiserDeps = {
    store,
    vision,
    embedder,
    logger,
    pricer,
    config: pipeline,
    // Every Item a capture prices goes to the Refiner next.
    onItemFinished: (itemId, owner) => store.enqueueRefine(itemId, owner, "created"),
  };
  const models = new ClaudeRefinerModels(anthropic, onRun, {
    researchModel: env.REFINER_RESEARCH_MODEL,
    researchMaxSearches: env.REFINER_RESEARCH_MAX_SEARCHES,
  });
  const refinerDeps: RefinerDeps = { store, models, pricer, logger, config: refiner };
  return { appraiser, refiner: refinerDeps };
}

const reasonOf = (raw: unknown): RefineReason => REASONS.find((r) => r === raw) ?? "created";

async function runJob(job: Job) {
  const userId = String(job.payload.user_id ?? "");
  const captureId = String(job.payload.capture_id ?? "");
  const itemId = String(job.payload.item_id ?? "");
  const runs: Promise<void>[] = [];
  const started = Date.now();
  try {
    if (job.kind === "drop_circle" && prospector) {
      const circleId = String(job.payload.circle_id ?? "");
      const review = new ClaudeReviewModel(anthropic, recorder(null, "drop", runs));
      const outcome = await prospectCircle(circleId, { ...prospector, review });
      await queue.finish(job.id);
      logger.info("job_done", {
        job_id: job.id,
        kind: job.kind,
        circle_id: circleId,
        outcome: outcome.status,
        ...(outcome.status === "matched"
          ? {
              deals: outcome.deals.length,
              staged: outcome.deals.filter((d) => d.staged.result === "ok").length,
            }
          : { reason: outcome.reason }),
        ms: Date.now() - started,
      });
    } else if (job.kind === "prospect_ask" && prospector) {
      // The review's model runs are attributed to the asker whose job this is.
      const review = new ClaudeReviewModel(anthropic, recorder(userId, "prospect", runs));
      const outcome = await prospectAsk(String(job.payload.ask_id ?? ""), userId, {
        ...prospector,
        review,
      });
      await queue.finish(job.id);
      logger.info("job_done", {
        job_id: job.id,
        kind: job.kind,
        ask_id: job.payload.ask_id,
        outcome: outcome.status,
        ...(outcome.status === "matched"
          ? {
              edges: outcome.edges,
              deals: outcome.deals.length,
              staged: outcome.deals.flatMap((d) =>
                d.staged.result === "ok" ? [d.staged.dealId] : [],
              ),
              refused: outcome.deals.flatMap((d) =>
                d.staged.result === "ok" || d.staged.result === "dropped" ? [] : [d.staged.result],
              ),
              dropped: outcome.deals.flatMap((d) =>
                d.staged.result === "dropped" ? [d.staged.reason] : [],
              ),
            }
          : { reason: outcome.reason }),
        ms: Date.now() - started,
      });
    } else if (job.kind === "extract_memory") {
      const payload = ExtractMemoryPayload.parse(job.payload);
      const outcome = await extractMemory(payload, {
        store: memoryStore,
        createModel: (onRun) => new ClaudeMemoryModel(anthropic, onRun),
        logger,
      });
      await queue.finish(job.id);
      logger.info("job_done", {
        job_id: job.id,
        kind: job.kind,
        outcome: outcome.status,
        written: outcome.written,
        ms: Date.now() - started,
      });
    } else if (job.kind === "refine_item") {
      const reason = reasonOf(job.payload.reason);
      const deps = depsFor(userId, `refine_${reason}`, runs);
      const outcome = await refineItem(itemId, userId, reason, deps.refiner);
      await queue.finish(job.id);
      logger.info("job_done", {
        job_id: job.id,
        item_id: itemId,
        outcome: outcome.status,
        ms: Date.now() - started,
      });
    } else if (job.kind === "reappraise_item") {
      const outcome = await reappraiseItem(
        itemId,
        userId,
        depsFor(userId, "item_photos", runs).appraiser,
      );
      await queue.finish(job.id);
      // New photos: the Refiner scores them and re-ranks the questions.
      if (outcome === "updated") {
        await store
          .enqueueRefine(itemId, userId, "photos")
          .catch((err) => logger.warn("refine_handoff_failed", { error: String(err) }));
      }
      logger.info("job_done", {
        job_id: job.id,
        item_id: itemId,
        outcome,
        ms: Date.now() - started,
      });
    } else {
      const items = await appraiseCapture(captureId, depsFor(userId, "capture", runs).appraiser);
      await queue.finish(job.id);
      logger.info("job_done", {
        job_id: job.id,
        capture_id: captureId,
        items,
        ms: Date.now() - started,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("job_failed", {
      job_id: job.id,
      kind: job.kind,
      capture_id: captureId || undefined,
      item_id: itemId || undefined,
      attempt: job.attempts,
      error: message,
    });
    await queue.finish(job.id, message);
    if (job.attempts >= job.max_attempts) {
      if (job.kind === "reappraise_item" || job.kind === "refine_item") {
        // Leave the Item as it was, just no longer appraising.
        await store
          .setAppraising(itemId, false)
          .catch((e) => logger.error("clear_appraising_failed", { error: String(e) }));
      } else if (job.kind === "appraise_capture") {
        await store.failCapture(captureId, "Something went wrong reading these photos. Try again.");
      }
      // extract_memory: nothing to undo. A missed turn only means nothing was noted from it.
      // prospect_ask: nothing to undo either. The next change to the Ask queues a new run.
    }
  } finally {
    await Promise.all(runs);
  }
}

/** Jobs run at once. Refiner passes are short and independent, so 1 capture must not queue them. */
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 4));

/**
 * 1 lane: claim a job, run it, repeat. claim_job uses SKIP LOCKED, so lanes never collide.
 * Every job kind calls a model, so nothing is claimed while the day's budget is spent.
 */
async function lane() {
  while (!stopping) {
    try {
      const job = (await budget.allows()) ? await queue.claim(KINDS) : null;
      if (job) {
        await runJob(job);
        continue;
      }
    } catch (err) {
      logger.error("worker_loop_error", { error: String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, env.POLL_INTERVAL_MS));
  }
}

/** Deals expire after 24 hours staged or 48 hours awaiting approval; checked every minute. */
const EXPIRE_EVERY_MS = 60_000;

async function expireLoop() {
  while (!stopping) {
    try {
      const expired = await prospectorStore.expireDeals();
      if (expired > 0) logger.info("deals_expired", { count: expired });
    } catch (err) {
      logger.error("expire_deals_failed", { error: String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, EXPIRE_EVERY_MS));
  }
}

/** Logs whether the matcher answers, so a deploy shows the private network works. */
async function checkMatcher() {
  try {
    const res = await fetch(new URL("/healthz", env.MATCHER_URL), {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) logger.info("matcher_reachable", { url: env.MATCHER_URL });
    else logger.warn("matcher_unhealthy", { url: env.MATCHER_URL, status: res.status });
  } catch (err) {
    logger.error("matcher_unreachable", { url: env.MATCHER_URL, error: String(err) });
  }
}

/**
 * Queues the Prospector's timed work: Asks not prospected for 6 hours, and each Circle's
 * Sunday drop. The database decides what's due, so several workers can run this safely.
 */
const SCHEDULE_EVERY_MS = 10 * 60_000;

async function scheduleLoop() {
  while (!stopping) {
    try {
      const queued = await prospectorStore.enqueueScheduled();
      if (queued.prospects > 0 || queued.drops > 0) logger.info("prospects_scheduled", queued);
    } catch (err) {
      logger.error("schedule_failed", { error: String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, SCHEDULE_EVERY_MS));
  }
}

async function main() {
  if (!prospector) logger.warn("prospector_off", { reason: "MATCHER_URL is not set" });
  else void checkMatcher();
  logger.info("worker_started", {
    kinds: KINDS,
    pricing,
    pipeline,
    refiner,
    concurrency: CONCURRENCY,
    daily_budget_cents: budget.budgetCents,
  });
  await Promise.all([
    ...Array.from({ length: CONCURRENCY }, () => lane()),
    expireLoop(),
    // No point queueing prospects nothing will claim.
    ...(prospector ? [scheduleLoop()] : []),
  ]);
  logger.info("worker_stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

void main();
