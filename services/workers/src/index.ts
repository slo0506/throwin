import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { ClaudeVision, type ModelRun } from "./appraiser/claude.js";
import { VoyageEmbedder } from "./appraiser/embeddings.js";
import { appraiseCapture } from "./appraiser/pipeline.js";
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
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3 });
const embedder = new VoyageEmbedder(env.VOYAGE_API_KEY);

const KINDS = ["appraise_capture"];
let stopping = false;

async function runJob(job: Job) {
  const captureId = String(job.payload.capture_id ?? "");
  const userId = String(job.payload.user_id ?? "");
  const runs: Promise<void>[] = [];
  const vision = new ClaudeVision(anthropic, (run: ModelRun) => {
    runs.push(
      store
        .recordRun(userId, run)
        .catch((err) => logger.warn("record_run_failed", { error: String(err) })),
    );
  });
  const started = Date.now();
  try {
    const items = await appraiseCapture(captureId, { store, vision, embedder, logger });
    await queue.finish(job.id);
    logger.info("job_done", {
      job_id: job.id,
      capture_id: captureId,
      items,
      ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("job_failed", {
      job_id: job.id,
      capture_id: captureId,
      attempt: job.attempts,
      error: message,
    });
    await queue.finish(job.id, message);
    if (job.attempts >= job.max_attempts) {
      await store.failCapture(captureId, "Something went wrong reading these photos. Try again.");
    }
  } finally {
    await Promise.all(runs);
  }
}

async function main() {
  logger.info("worker_started", { kinds: KINDS });
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
