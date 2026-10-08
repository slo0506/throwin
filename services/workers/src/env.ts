import { z } from "zod";
import { MODELS } from "./appraiser/claude.js";

const modelId = (m: "haiku" | "sonnet") => (m === "haiku" ? MODELS.fast : MODELS.smart);

const EnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  VOYAGE_API_KEY: z.string().min(1),
  /** How often an idle worker checks the queue. */
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(1500),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Identify calls at once (Sonnet, 3 images each). */
  PARALLEL_IDENTIFY: z.coerce.number().int().min(1).max(12).default(5),
  /** Items priced at once. */
  PARALLEL_PRICING: z.coerce.number().int().min(1).max(12).default(10),
  /** Model for price research. */
  PRICE_RESEARCH_MODEL: z.enum(["haiku", "sonnet"]).default("haiku").transform(modelId),
  /** Re-research with this model when the first estimate is weak; "none" disables it. */
  PRICE_FALLBACK_MODEL: z
    .enum(["haiku", "sonnet", "none"])
    .default("sonnet")
    .transform((m) => (m === "none" ? null : modelId(m))),
  /** Fall back when the first estimate's confidence is below this. */
  PRICE_FALLBACK_BELOW: z.coerce.number().min(0).max(1).default(0.4),
  /** web_search max_uses per research turn. */
  PRICE_MAX_SEARCHES: z.coerce.number().int().min(1).max(10).default(2),
  /** max_tokens per research request. */
  PRICE_RESEARCH_MAX_TOKENS: z.coerce.number().int().min(256).max(8000).default(1024),
  /** How long a researched price is reused for the same product and grade. 0 disables. */
  PRICE_CACHE_TTL_DAYS: z.coerce.number().min(0).max(90).default(7),
  /** Only estimates at least this confident are written to the cache. */
  PRICE_CACHE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  /** Draw a light labeled coordinate grid on detection images ("false" turns it off). */
  DETECT_GRID: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Open Refiner questions per Item at most. */
  REFINER_MAX_OPEN_QUESTIONS: z.coerce.number().int().min(0).max(5).default(3),
  /** SKU research with web search ("false" turns it off). */
  REFINER_RESEARCH: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Model for SKU research. */
  REFINER_RESEARCH_MODEL: z.enum(["haiku", "sonnet"]).default("sonnet").transform(modelId),
  /** web_search max_uses per research pass. */
  REFINER_RESEARCH_MAX_SEARCHES: z.coerce.number().int().min(1).max(5).default(2),
  /** Research only Items whose mid value is at least this, in cents. */
  REFINER_RESEARCH_MIN_MID_CENTS: z.coerce.number().int().min(0).default(4000),
  /** At most 1 research pass per Item in this window, unless the owner added information. */
  REFINER_RESEARCH_COOLDOWN_HOURS: z.coerce.number().min(0).max(720).default(24),
  /** A question skipped once may come back after this long. Skipped twice means never. */
  REFINER_REASK_AFTER_HOURS: z.coerce.number().min(0).max(2160).default(72),
  /** Laplacian variance at or below which a photo scores 0 for sharpness. */
  REFINER_SHARPNESS_LOW: z.coerce.number().min(0).default(20),
  /** Laplacian variance at or above which a photo scores full marks for sharpness. */
  REFINER_SHARPNESS_HIGH: z.coerce.number().min(1).default(200),
  /**
   * The matcher service's base URL. Unset: prospect_ask jobs wait in the queue rather than
   * fail, so nothing is lost before the matcher is deployed.
   */
  MATCHER_URL: z.url().optional(),
  /**
   * Want candidates below this embedding similarity are dropped unless the model number
   * matches. A starting guess: tune it on real Asks once they exist.
   */
  PROSPECT_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  /** Nearest offered Items considered per Ask. */
  PROSPECT_CANDIDATES_PER_ASK: z.coerce.number().int().min(1).max(200).default(25),
  /** Asks embedded per prospect run at most. */
  PROSPECT_MAX_EMBEDS: z.coerce.number().int().min(1).max(500).default(50),
  /** The matcher's selection time limit per call. */
  MATCHER_TIME_LIMIT_SECONDS: z.coerce.number().min(1).max(60).default(5),
  /** Items 1 person may hand another in 1 Deal (bundles, X for Y). 1 means 1 for 1. */
  PROSPECT_MAX_ITEMS_PER_LEG: z.coerce.number().int().min(1).max(5).default(3),
  /** Guesses ("would a PS5 work instead of an Xbox?") the Liaison asks about ("false" turns them off). */
  PROSPECT_INFERRED_EDGES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** A guess shares the Ask's top-level category and reaches this embedding similarity. */
  PROSPECT_INFER_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.15),
  /** Guesses per Ask the matcher may try. */
  PROSPECT_INFER_PER_ASK: z.coerce.number().int().min(1).max(10).default(3),
  /** Owners told "someone wants your Item" per live run that staged nothing (0 turns it off). */
  PROSPECT_INTERESTS_PER_ASK: z.coerce.number().int().min(0).max(5).default(2),
  /** SDK retries per Anthropic call (429 and 5xx, with backoff). */
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
  /**
   * Model spend the background agents may use in any 24 hours, in cents. Over it, jobs wait
   * in the queue (docs/setup.md, "Spend caps"). GM chat has its own caps in the API.
   */
  WORKER_DAILY_BUDGET_CENTS: z.coerce.number().int().min(1).default(500),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
