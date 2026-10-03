import {
  type AppraiserStore,
  appraiseCapture,
  type CaptureMedia,
  type Embedder,
  type Logger,
  type ModelRun,
  type NewItem,
  type Progress,
  type Vision,
} from "@throwin/workers/eval";
import type { Frame } from "./frames.js";
import type { PredictedItem } from "./match.js";

const USER = "eval-user";

/** Holds 1 capture in memory: frames in, Items out. Nothing leaves the process. */
export class MemoryStore implements AppraiserStore {
  readonly files = new Map<string, Buffer>();
  readonly items: NewItem[] = [];
  readonly progress: Progress[] = [];
  readonly media: CaptureMedia[];

  constructor(
    readonly captureId: string,
    frames: Frame[],
  ) {
    this.media = frames.map((f, position) => {
      const path = `${USER}/${captureId}/${position}.jpg`;
      this.files.set(path, f.jpeg);
      return { path, position, sharpness: f.sharpness };
    });
  }

  async loadCapture(captureId: string) {
    return captureId === this.captureId ? { userId: USER, media: this.media } : null;
  }
  async clearCaptureItems() {
    this.items.length = 0;
  }
  async download(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`missing ${path}`);
    return file;
  }
  async upload(path: string, jpeg: Buffer) {
    this.files.set(path, jpeg);
  }
  async setProgress(_: string, progress: Progress) {
    this.progress.push(progress);
  }
  async insertItem(item: NewItem) {
    this.items.push(item);
    return `item-${this.items.length}`;
  }
  async saveEmbedding() {}
  async finishCapture(_: string, __: number, progress: Progress) {
    this.progress.push(progress);
  }
  async failCapture() {}
  async recordRun() {}
}

/** Used when VOYAGE_API_KEY is absent. Embeddings don't affect what the eval scores. */
export const noopEmbedder: Embedder = {
  model: "none",
  async embed() {
    return [];
  },
};

const toCents = (usd: number) => Math.round(usd * 100);

export function toPredicted(item: NewItem): PredictedItem {
  const id = item.identification;
  return {
    title: item.title,
    category: id.category,
    brand: id.brand,
    model: id.model,
    condition_grade: id.condition_grade,
    status: item.status,
    follow_up: id.follow_up,
    value: item.value
      ? {
          low: toCents(item.value.low_usd),
          mid: toCents(item.value.mid_usd),
          high: toCents(item.value.high_usd),
        }
      : null,
  };
}

export interface CaptureRun {
  predicted: PredictedItem[];
  latencyMs: number;
  runs: ModelRun[];
  error: string | null;
}

/**
 * Runs the Appraiser on 1 capture, in-process, timed from loading the capture to the last
 * Item saved. `makeVision` gets a callback that records every model run, for cost.
 */
export async function runCapture(
  captureId: string,
  frames: Frame[],
  deps: {
    makeVision: (onRun: (run: ModelRun) => void) => Vision;
    embedder: Embedder;
    logger: Logger;
    now?: () => number;
  },
): Promise<CaptureRun> {
  const now = deps.now ?? (() => performance.now());
  const runs: ModelRun[] = [];
  const store = new MemoryStore(captureId, frames);
  const vision = deps.makeVision((run) => runs.push(run));
  const started = now();
  let error: string | null = null;
  try {
    await appraiseCapture(captureId, {
      store,
      vision,
      embedder: deps.embedder,
      logger: deps.logger,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Math.round(now() - started);
  return { predicted: store.items.map(toPredicted), latencyMs, runs, error };
}
