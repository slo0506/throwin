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
  /** SDK retries per Anthropic call (429 and 5xx, with backoff). */
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
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
