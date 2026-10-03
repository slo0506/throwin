import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { ClaudeVision, type ModelRun, type PricingConfig } from "./appraiser/claude.js";
import { VoyageEmbedder } from "./appraiser/embeddings.js";
import { type AppraiserDeps, appraiseCapture, reappraiseItem } from "./appraiser/pipeline.js";
import { CachedPricer } from "./appraiser/price-cache.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./log.js";
import { type Job, SupabaseAppraiserStore, SupabaseQueue } from "./store.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const queue = new SupabaseQueue(db);
const store = new SupabaseAppraiserStore(db);
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

const KINDS = ["appraise_capture", "reappraise_item"];
let stopping = false;

/** Per-job dependencies: model runs are attributed to the job's user and trigger. */
function depsFor(userId: string, trigger: string, runs: Promise<void>[]): AppraiserDeps {
  const vision = new ClaudeVision(
    anthropic,
    (run: ModelRun) => {
      runs.push(
        store
          .recordRun(userId, run, trigger)
          .catch((err) => logger.warn("record_run_failed", { error: String(err) })),
      );
    },
    pricing,
  );
  const pricer = new CachedPricer(
    vision,
    store,
    { ttlDays: env.PRICE_CACHE_TTL_DAYS, minConfidence: env.PRICE_CACHE_MIN_CONFIDENCE },
    (op, err) => logger.warn(op, { error: String(err) }),
  );
  return { store, vision, embedder, logger, pricer, config: pipeline };
}

async function runJob(job: Job) {
  const userId = String(job.payload.user_id ?? "");
  const captureId = String(job.payload.capture_id ?? "");
  const itemId = String(job.payload.item_id ?? "");
  const runs: Promise<void>[] = [];
  const started = Date.now();
  try {
    if (job.kind === "reappraise_item") {
      const outcome = await reappraiseItem(itemId, userId, depsFor(userId, "item_photos", runs));
      await queue.finish(job.id);
      logger.info("job_done", {
        job_id: job.id,
        item_id: itemId,
        outcome,
        ms: Date.now() - started,
      });
    } else {
      const items = await appraiseCapture(captureId, depsFor(userId, "capture", runs));
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
      if (job.kind === "reappraise_item") {
        // Leave the Item as it was, just no longer appraising.
        await store
          .setAppraising(itemId, false)
          .catch((e) => logger.error("clear_appraising_failed", { error: String(e) }));
      } else {
        await store.failCapture(captureId, "Something went wrong reading these photos. Try again.");
      }
    }
  } finally {
    await Promise.all(runs);
  }
}

async function main() {
  logger.info("worker_started", { kinds: KINDS, pricing, pipeline });
  while (!stopping) {
    try {
      const job = await queue.claim(KINDS);
      if (job) {
        await runJob(job);
        continue;
      }
    } catch (err) {
      logger.error("worker_loop_error", { error: String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, env.POLL_INTERVAL_MS));
  }
  logger.info("worker_stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

void main();
