/**
 * What the eval runner (`evals/runner`) uses to run the Appraiser in-process. Re-exports
 * only: nothing here changes how the worker behaves. Imported as `@throwin/workers/eval`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeVision, type ModelRun } from "./appraiser/claude.js";

export { ClaudeVision, MODELS, type ModelRun, type Vision } from "./appraiser/claude.js";
export { type Embedder, VoyageEmbedder } from "./appraiser/embeddings.js";
export { MAX_EDGE, type PreparedImage, prepare } from "./appraiser/images.js";
export {
  type AppraiserDeps,
  type AppraiserStore,
  appraiseCapture,
  type CaptureMedia,
  CONFIDENCE_THRESHOLD,
  type NewItem,
  type Progress,
} from "./appraiser/pipeline.js";
export type { Detection, Identification, ValueEstimate } from "./appraiser/schemas.js";
export { createLogger, type Logger, silentLogger } from "./log.js";

/** The production Vision, built the way the worker builds it, reporting every model run. */
export function createClaudeVision(apiKey: string, onRun: (run: ModelRun) => void) {
  return new ClaudeVision(new Anthropic({ apiKey, maxRetries: 3 }), onRun);
}
