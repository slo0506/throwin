import sharp from "sharp";
import { expect } from "vitest";
import type { PriceResult, Vision } from "../src/appraiser/claude.js";
import type { Embedder } from "../src/appraiser/embeddings.js";
import type { PreparedImage } from "../src/appraiser/images.js";
import type {
  AppraiserStore,
  ItemMedia,
  NewItem,
  PricedItem,
  Progress,
  ReappraisedItem,
  StoredItem,
} from "../src/appraiser/pipeline.js";
import type { CachedPrice } from "../src/appraiser/price-cache.js";
import type { Detection, Identification } from "../src/appraiser/schemas.js";

export const USER = "u1";
export const CAPTURE = "c1";

export async function solidJpeg(color: string, width = 1600, height = 1200) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

/** A sharp-edged test image: a checkerboard has a high Laplacian variance. */
export async function checkerJpeg(width = 1200, height = 900, cell = 20) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 255 : 0;
      pixels.fill(on, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toBuffer();
}

export interface StoredTestItem extends NewItem {
  id: string;
  appraising: boolean;
  priced: PricedItem | null;
  media: ItemMedia[];
  appraisals: number;
}

export class MemoryStore implements AppraiserStore {
  files = new Map<string, Buffer>();
  progress: Progress[] = [];
  items: StoredTestItem[] = [];
  embeddings: { itemId: string; vector: number[] }[] = [];
  finished: { count: number; progress: Progress } | null = null;
  failed: string | null = null;
  cleared = 0;
  /** Ordered log of writes, to check that Items appear before they are priced. */
  events: string[] = [];
  cache = new Map<string, CachedPrice>();
  reappraisals: { itemId: string; update: ReappraisedItem }[] = [];
  media = [
    { path: `${USER}/${CAPTURE}/0.jpg`, position: 0, sharpness: 10 },
    { path: `${USER}/${CAPTURE}/1.jpg`, position: 1, sharpness: 50 },
  ];

  async loadCapture() {
    return { userId: USER, media: this.media };
  }
  async clearCaptureItems() {
    this.cleared++;
  }
  async download(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`missing ${path}`);
    return file;
  }
  async upload(path: string, jpeg: Buffer) {
    this.files.set(path, jpeg);
  }
  async setProgress(_: string, p: Progress) {
    this.progress.push(p);
  }
  async insertItem(item: NewItem) {
    const id = `item-${this.items.length}`;
    this.items.push({
      ...item,
      id,
      appraising: true,
      priced: null,
      appraisals: 0,
      media: [{ id: `${id}-m0`, path: item.cropPath, position: 0, createdAt: new Date(0) }],
    });
    this.events.push(`insert:${id}`);
    return id;
  }
  async finishItem(itemId: string, priced: PricedItem) {
    const item = this.item(itemId);
    item.priced = priced;
    item.appraising = false;
    item.appraisals++;
    this.events.push(`finish:${itemId}`);
  }
  async saveEmbedding(itemId: string, _model: string, vector: number[]) {
    this.embeddings.push({ itemId, vector });
  }
  async finishCapture(_: string, count: number, progress: Progress) {
    this.finished = { count, progress };
    this.events.push("capture_done");
  }
  async failCapture(_: string, message: string) {
    this.failed = message;
    for (const i of this.items) i.appraising = false;
  }
  async recordRun() {}

  async getCachedPrice(key: string, grade: string) {
    return this.cache.get(`${key}#${grade}`) ?? null;
  }
  async putCachedPrice(key: string, grade: string, price: CachedPrice) {
    this.cache.set(`${key}#${grade}`, price);
  }

  async loadItem(itemId: string, userId: string): Promise<StoredItem | null> {
    const item = this.items.find((i) => i.id === itemId && i.userId === userId);
    if (!item) return null;
    return {
      id: item.id,
      userId: item.userId,
      appraising: item.appraising,
      identification: item.identification,
      hasValue: item.priced?.value != null,
      media: item.media.map((m) => ({ ...m })),
    };
  }
  async saveReappraisal(itemId: string, update: ReappraisedItem) {
    const item = this.item(itemId);
    item.identification = update.identification;
    item.title = update.identification.title;
    item.status = update.status;
    if (update.priced) item.priced = update.priced;
    item.appraising = false;
    item.appraisals++;
    this.reappraisals.push({ itemId, update });
  }
  async addHero(itemId: string, path: string, _image: PreparedImage) {
    const item = this.item(itemId);
    for (const m of item.media) m.position++;
    item.media.unshift({ id: `${itemId}-hero`, path, position: 0, createdAt: new Date() });
  }
  async setAppraising(itemId: string, appraising: boolean) {
    this.item(itemId).appraising = appraising;
  }

  /** Adds follow-up photos the way submit_item_media does: 1 batch, 1 timestamp. */
  addPhotos(itemId: string, paths: string[], at = new Date()) {
    const item = this.item(itemId);
    let next = Math.max(...item.media.map((m) => m.position)) + 1;
    for (const path of paths) {
      item.media.push({ id: `${itemId}-${path}`, path, position: next++, createdAt: at });
    }
    item.appraising = true;
  }

  item(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`no item ${itemId}`);
    return item;
  }
}

export const identification = (overrides: Partial<Identification> = {}): Identification => ({
  is_tradeable_item: true,
  title: "LEGO Typewriter 21327",
  category: "toys/lego",
  brand: "LEGO",
  model: "21327",
  variant: null,
  attributes: { box: "yes" },
  condition_grade: "B",
  defects: [],
  age_estimate_years: [1, 3],
  identity_confidence: 0.9,
  condition_confidence: 0.8,
  follow_up: null,
  ...overrides,
});

export const priceResult = (mid = 165, confidence = 0.8): PriceResult => ({
  value: {
    low_usd: mid - 25,
    mid_usd: mid,
    high_usd: mid + 25,
    basis: [`eBay sold $${mid}`],
    confidence,
  },
  research: "notes",
  model: "claude-haiku-4-5-20251001",
});

export type FakeVision = Vision & {
  identifyCalls: number;
  sameCalls: number;
  priceCalls: number;
  reidentifyCalls: number;
  priceImpl: (item: Identification) => Promise<PriceResult>;
  reidentifyImpl: (previous: Identification, photos: PreparedImage[]) => Promise<Identification>;
};

export function fakeVision(
  detection: Detection,
  idents: Identification[],
  same = false,
): FakeVision {
  let i = 0;
  return {
    identifyCalls: 0,
    sameCalls: 0,
    priceCalls: 0,
    reidentifyCalls: 0,
    priceImpl: async () => priceResult(),
    reidentifyImpl: async (previous) => previous,
    async sameItem() {
      this.sameCalls++;
      return same;
    },
    async detect() {
      return detection;
    },
    async identify(crops) {
      this.identifyCalls++;
      expect(crops.length).toBeGreaterThan(0);
      for (const c of crops) expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(1000);
      return idents[i++ % idents.length] as Identification;
    },
    async reidentify(previous, hero, photos) {
      this.reidentifyCalls++;
      expect(hero.width).toBeGreaterThan(0);
      for (const p of photos) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1000);
      return this.reidentifyImpl(previous, photos);
    },
    async price(item) {
      this.priceCalls++;
      return this.priceImpl(item);
    },
  };
}

export const embedder: Embedder = { model: "test-embed", embed: async () => [0.1, 0.2] };

export async function setup() {
  const store = new MemoryStore();
  const colors = ["#ff7a2f", "#2fc4ff"];
  for (const [i, m] of store.media.entries()) {
    store.files.set(m.path, await solidJpeg(colors[i] ?? "#7a5cff"));
  }
  return store;
}
