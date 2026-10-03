import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Vision } from "../src/appraiser/claude.js";
import type { Embedder } from "../src/appraiser/embeddings.js";
import {
  type AppraiserStore,
  appraiseCapture,
  bestAppearances,
  type NewItem,
  type Progress,
} from "../src/appraiser/pipeline.js";
import type { Detection, Identification } from "../src/appraiser/schemas.js";
import { silentLogger } from "../src/log.js";

const USER = "u1";
const CAPTURE = "c1";

async function solidJpeg(color: string, width = 1600, height = 1200) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

class MemoryStore implements AppraiserStore {
  files = new Map<string, Buffer>();
  progress: Progress[] = [];
  items: (NewItem & { id: string })[] = [];
  embeddings: { itemId: string; vector: number[] }[] = [];
  finished: { count: number; progress: Progress } | null = null;
  cleared = 0;
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
    this.items.push({ ...item, id });
    return id;
  }
  async saveEmbedding(itemId: string, _model: string, vector: number[]) {
    this.embeddings.push({ itemId, vector });
  }
  async finishCapture(_: string, count: number, progress: Progress) {
    this.finished = { count, progress };
  }
  async failCapture() {}
  async recordRun() {}
}

const identification = (overrides: Partial<Identification> = {}): Identification => ({
  is_tradeable_item: true,
  title: "LEGO Typewriter 21327",
  category: "toys/lego",
  brand: "LEGO",
  model: "21327",
  variant: null,
  attributes: { box: true },
  condition_grade: "B",
  defects: [],
  age_estimate_years: [1, 3],
  identity_confidence: 0.9,
  condition_confidence: 0.8,
  follow_up: null,
  ...overrides,
});

function fakeVision(
  detection: Detection,
  idents: Identification[],
): Vision & { identifyCalls: number } {
  let i = 0;
  return {
    identifyCalls: 0,
    async detect() {
      return detection;
    },
    async identify(crops) {
      this.identifyCalls++;
      expect(crops.length).toBeGreaterThan(0);
      for (const c of crops) expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(1000);
      return idents[i++ % idents.length] as Identification;
    },
    async price() {
      return {
        value: {
          low_usd: 140,
          mid_usd: 165,
          high_usd: 190,
          basis: ["eBay sold $165"],
          confidence: 0.8,
        },
        research: "notes",
      };
    },
  };
}

const embedder: Embedder = { model: "test-embed", embed: async () => [0.1, 0.2] };

async function setup() {
  const store = new MemoryStore();
  const colors = ["#ff7a2f", "#2fc4ff"];
  for (const [i, m] of store.media.entries()) {
    store.files.set(m.path, await solidJpeg(colors[i] ?? "#7a5cff"));
  }
  return store;
}

describe("appraiseCapture", () => {
  it("turns detected objects into priced Items with crops and embeddings", async () => {
    const store = await setup();
    const vision = fakeVision(
      {
        objects: [
          {
            label: "LEGO box",
            category: "toys/lego",
            appearances: [
              { frame: 0, box: [0.1, 0.1, 0.4, 0.5] },
              { frame: 1, box: [0.1, 0.1, 0.5, 0.6] },
            ],
          },
          {
            label: "sneaker",
            category: "sneakers",
            appearances: [{ frame: 1, box: [0.6, 0.5, 0.9, 0.9] }],
          },
        ],
      },
      [
        identification(),
        identification({
          title: "Air Jordan 1 Mid",
          identity_confidence: 0.6,
          follow_up: "Photo of the size tag",
        }),
      ],
    );

    const saved = await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger });

    expect(saved).toBe(2);
    expect(store.cleared).toBe(1);
    expect(store.items.map((i) => i.status).sort()).toEqual(["needs_photos", "on_shelf"]);
    const sneaker = store.items.find((i) => i.title === "Air Jordan 1 Mid");
    expect(sneaker?.identification.follow_up).toBe("Photo of the size tag");
    const lego = store.items.find((i) => i.title.startsWith("LEGO"));
    expect(lego?.identification.follow_up).toBeNull();
    expect(lego?.value?.mid_usd).toBe(165);
    expect(store.files.has(lego!.cropPath)).toBe(true);
    expect(store.embeddings).toHaveLength(2);
    expect(store.finished).toEqual({
      count: 2,
      progress: expect.objectContaining({ stage: "done", detail: "Added 2 items to your Shelf" }),
    });
    expect(store.progress.some((p) => p.stage === "pricing")).toBe(true);
  });

  it("skips things that are not tradeable and keeps going when 1 item fails", async () => {
    const store = await setup();
    const vision = fakeVision(
      {
        objects: [
          { label: "shelf", category: "other", appearances: [{ frame: 0, box: [0, 0, 1, 1] }] },
          {
            label: "game",
            category: "video_games",
            appearances: [{ frame: 0, box: [0.2, 0.2, 0.3, 0.3] }],
          },
        ],
      },
      [identification({ is_tradeable_item: false }), identification({ title: "Mario Kart 8" })],
    );
    const flaky: Embedder = {
      model: "x",
      embed: async () => {
        throw new Error("voyage down");
      },
    };
    const saved = await appraiseCapture(CAPTURE, {
      store,
      vision,
      embedder: flaky,
      logger: silentLogger,
    });
    expect(saved).toBe(1);
    expect(store.items[0]?.title).toBe("Mario Kart 8");
  });

  it("finishes with a helpful message when nothing is found", async () => {
    const store = await setup();
    const saved = await appraiseCapture(CAPTURE, {
      store,
      vision: fakeVision({ objects: [] }, []),
      embedder,
      logger: silentLogger,
    });
    expect(saved).toBe(0);
    expect(store.finished?.progress.detail).toContain("Try closer");
  });
});

describe("bestAppearances", () => {
  it("prefers the largest box, then the sharper frame, and drops frames that don't exist", () => {
    const media = [
      { path: "a", position: 0, sharpness: 5 },
      { path: "b", position: 1, sharpness: 90 },
    ];
    const best = bestAppearances(
      {
        label: "x",
        category: "y",
        appearances: [
          { frame: 0, box: [0, 0, 0.5, 0.5] },
          { frame: 1, box: [0, 0, 0.5, 0.5] },
          { frame: 7, box: [0, 0, 1, 1] },
        ],
      },
      media,
    );
    expect(best.map((a) => a.frame)).toEqual([1, 0]);
  });
});
