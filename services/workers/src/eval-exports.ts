/**
 * What the eval runner (`evals/runner`) uses to run the Appraiser in-process. Re-exports
 * only: nothing here changes how the worker behaves. Imported as `@throwin/workers/eval`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeVision, DEFAULT_PRICING, type ModelRun } from "./appraiser/claude.js";

export {
  ClaudeVision,
  DEFAULT_PRICING,
  MODELS,
  type ModelRun,
  type PriceResult,
  type PricingConfig,
  type Vision,
} from "./appraiser/claude.js";
export { type Embedder, VoyageEmbedder } from "./appraiser/embeddings.js";
export { MAX_EDGE, type PreparedImage, prepare } from "./appraiser/images.js";
export {
  type AppraiserDeps,
  type AppraiserStore,
  appraiseCapture,
  type CaptureMedia,
  CONFIDENCE_THRESHOLD,
  DEFAULT_PIPELINE,
  type ItemMedia,
  type NewItem,
  type PipelineConfig,
  type PricedItem,
  type Progress,
  type ReappraisedItem,
  type StoredItem,
} from "./appraiser/pipeline.js";
export {
  type CachedPrice,
  CachedPricer,
  DEFAULT_PRICE_CACHE,
  type PriceCacheStore,
} from "./appraiser/price-cache.js";
export { looksPrivate } from "./appraiser/privacy.js";
export type { Detection, Identification, ValueEstimate } from "./appraiser/schemas.js";
export { createLogger, type Logger, silentLogger } from "./log.js";

/** SDK retries per call, the worker's ANTHROPIC_MAX_RETRIES default. */
const MAX_RETRIES = 4;

/**
 * The production Vision, built the way the worker builds it with its default settings,
 * reporting every model run.
 */
export function createClaudeVision(apiKey: string, onRun: (run: ModelRun) => void) {
  return new ClaudeVision(
    new Anthropic({ apiKey, maxRetries: MAX_RETRIES }),
    onRun,
    DEFAULT_PRICING,
  );
}
