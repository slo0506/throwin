import {
  type AppraiserStore,
  appraiseCapture,
  type CachedPrice,
  type CaptureMedia,
  type Embedder,
  type Identification,
  type Logger,
  type ModelRun,
  type NewItem,
  type PricedItem,
  type Progress,
  type Vision,
} from "@throwin/workers/eval";
import type { Frame } from "./frames.js";
import type { PredictedItem } from "./match.js";

const USER = "eval-user";

/** An Item as the Appraiser left it: inserted unpriced, then finished in place. */
export interface StoredEvalItem {
  id: string;
  item: NewItem;
  appraising: boolean;
  /** Set by finishItem. Null when the Item was never finished. */
  priced: PricedItem | null;
  /** Clock reading when the Item was inserted and when it was finished. */
  insertedAt: number;
  finishedAt: number | null;
}

/**
 * Holds 1 capture in memory: frames in, Items out. Nothing leaves the process. The price
 * cache lives in this store too, so each trial starts cold, like a user's first capture of
 * things nobody else has priced this week; copies within 1 capture still share a price.
 */
export class MemoryStore implements AppraiserStore {
  readonly files = new Map<string, Buffer>();
  readonly items: StoredEvalItem[] = [];
  readonly progress: Progress[] = [];
  readonly priceCache = new Map<string, CachedPrice>();
  readonly media: CaptureMedia[];

  constructor(
    readonly captureId: string,
    frames: Frame[],
    private readonly now: () => number = () => performance.now(),
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
    const id = `item-${this.items.length + 1}`;
    this.items.push({
      id,
      item,
      appraising: true,
      priced: null,
      insertedAt: this.now(),
      finishedAt: null,
    });
    return id;
  }
  async finishItem(itemId: string, priced: PricedItem) {
    const stored = this.#find(itemId);
    stored.priced = priced;
    stored.appraising = false;
    stored.finishedAt = this.now();
  }
  async saveEmbedding() {}
  async finishCapture(_: string, __: number, progress: Progress) {
    this.progress.push(progress);
  }
  async failCapture() {
    for (const i of this.items) i.appraising = false;
  }
  async recordRun() {}
  async getCachedPrice(key: string, grade: Identification["condition_grade"]) {
    return this.priceCache.get(`${key}#${grade}`) ?? null;
  }
  async putCachedPrice(key: string, grade: Identification["condition_grade"], p: CachedPrice) {
    this.priceCache.set(`${key}#${grade}`, p);
  }

  // Follow-up photos are not part of a capture eval.
  async loadItem() {
    return null;
  }
  async saveReappraisal(): Promise<void> {
    throw new Error("reappraisal is not part of the capture eval");
  }
  async addHero(): Promise<void> {
    throw new Error("reappraisal is not part of the capture eval");
  }
  async setAppraising(itemId: string, appraising: boolean) {
    this.#find(itemId).appraising = appraising;
  }

  #find(itemId: string) {
    const stored = this.items.find((i) => i.id === itemId);
    if (!stored) throw new Error(`missing item ${itemId}`);
    return stored;
  }
}

/** Used when VOYAGE_API_KEY is absent. Embeddings don't affect what the eval scores. */
export const noopEmbedder: Embedder = {
  model: "none",
  async embed() {
    return [];
  },
};

const toCents = (usd: number) => Math.round(usd * 100);

/**
 * The Item as the user ends up seeing it. The finish step is final: its identification
 * and value win. An Item that was never finished has no value, so it can't be correct.
 */
export function toPredicted(stored: StoredEvalItem): PredictedItem {
  const id = stored.priced?.identification ?? stored.item.identification;
  const value = stored.priced?.value ?? null;
  return {
    title: id.title,
    category: id.category,
    brand: id.brand,
    model: id.model,
    condition_grade: id.condition_grade,
    status: stored.item.status,
    follow_up: id.follow_up,
    value: value
      ? { low: toCents(value.low_usd), mid: toCents(value.mid_usd), high: toCents(value.high_usd) }
      : null,
  };
}

export interface CaptureRun {
  predicted: PredictedItem[];
  /** From loading the capture to the last Item finished with its value. */
  latencyMs: number;
  /** From loading the capture to the first Item on the Shelf (unpriced). Null if none. */
  firstItemMs: number | null;
  runs: ModelRun[];
  error: string | null;
}

/**
 * Runs the Appraiser on 1 capture, in-process, with production defaults for pricing and
 * concurrency. `makeVision` gets a callback that records every model run, for cost.
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
  const store = new MemoryStore(captureId, frames, now);
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
  const ended = now();
  const finishes = store.items.flatMap((i) => (i.finishedAt === null ? [] : [i.finishedAt]));
  const inserts = store.items.map((i) => i.insertedAt);
  // With nothing finished, the capture's own end is when the user learns the outcome.
  const lastFinish = finishes.length > 0 ? Math.max(...finishes) : ended;
  return {
    predicted: store.items.map(toPredicted),
    latencyMs: Math.round(lastFinish - started),
    firstItemMs: inserts.length > 0 ? Math.round(Math.min(...inserts) - started) : null,
    runs,
    error,
  };
}
