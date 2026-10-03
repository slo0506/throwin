import { describe, expect, it } from "vitest";
import type { Embedder } from "../src/appraiser/embeddings.js";
import {
  appraiseCapture,
  bestAppearances,
  DEFAULT_PIPELINE,
  looksAlike,
  titleOverlap,
} from "../src/appraiser/pipeline.js";
import type { Detection } from "../src/appraiser/schemas.js";
import { silentLogger } from "../src/log.js";
import { CAPTURE, embedder, fakeVision, identification, priceResult, setup } from "./support.js";

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
    expect(lego?.priced?.value?.mid_usd).toBe(165);
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

describe("progressive Items", () => {
  const threeThings: Detection = {
    objects: [0, 1, 2].map((n) => ({
      label: `thing ${n}`,
      category: "other",
      appearances: [{ frame: n % 2, box: [0.05 + n * 0.3, 0.1, 0.3 + n * 0.3, 0.4] }],
    })),
  };
  const idents = [
    identification({ title: "Mario Kart 8 Deluxe", brand: "Nintendo", model: null }),
    identification({ title: "Sony WH-1000XM4", brand: "Sony", model: "WH-1000XM4" }),
    identification({ title: "Catan board game", brand: "Catan", model: null }),
  ];

  it("saves every Item unpriced before pricing any, and finishes the capture last", async () => {
    const store = await setup();
    const vision = fakeVision(threeThings, idents);
    const seenWhilePricing: boolean[] = [];
    vision.priceImpl = async () => {
      // Every Item exists, still appraising, before the first price comes back.
      seenWhilePricing.push(store.items.length === 3 && store.items.some((i) => i.appraising));
      return priceResult();
    };
    await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger });

    const firstFinish = store.events.findIndex((e) => e.startsWith("finish:"));
    const inserts = store.events.filter((e) => e.startsWith("insert:"));
    expect(inserts).toHaveLength(3);
    expect(store.events.slice(0, firstFinish)).toEqual(inserts);
    expect(store.events.at(-1)).toBe("capture_done");
    expect(seenWhilePricing.every(Boolean)).toBe(true);
    expect(store.items.every((i) => !i.appraising && i.priced?.value)).toBe(true);
    expect(store.items.every((i) => i.appraisals === 1)).toBe(true);
    expect(store.progress.map((p) => p.detail)).toContain("Found 3 items. Pricing them now");
  });

  it("keeps an Item with a null value when pricing fails", async () => {
    const store = await setup();
    const vision = fakeVision(threeThings, idents);
    vision.priceImpl = async (item) => {
      if (item.brand === "Sony") throw new Error("research timed out");
      return priceResult();
    };
    expect(await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger })).toBe(
      3,
    );
    const sony = store.items.find((i) => i.identification.brand === "Sony");
    expect(sony?.appraising).toBe(false);
    expect(sony?.priced?.value).toBeNull();
    expect(store.finished?.count).toBe(3);
  });

  it("prices 2 copies of 1 product once, through the cache", async () => {
    const store = await setup();
    const sameGame = identification({
      title: "Mario Kart 8 Deluxe",
      brand: "Nintendo",
      model: null,
    });
    const vision = fakeVision(threeThings, [sameGame, sameGame, idents[1] ?? sameGame]);
    await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger });
    expect(vision.priceCalls).toBe(2);
    expect(store.cache.size).toBe(2);

    // A later capture of the same product reuses the cached range.
    const again = await setup();
    again.cache = store.cache;
    const vision2 = fakeVision(threeThings, [sameGame]);
    await appraiseCapture(CAPTURE, {
      store: again,
      vision: vision2,
      embedder,
      logger: silentLogger,
    });
    expect(vision2.priceCalls).toBe(0);
    expect(again.items[0]?.priced?.comps.cached).toBe(true);
    expect(again.items[0]?.priced?.value?.low_usd).toBe(140);
  });

  it("respects the concurrency limits", async () => {
    const store = await setup();
    const vision = fakeVision(threeThings, idents);
    let active = 0;
    let peak = 0;
    vision.priceImpl = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return priceResult();
    };
    await appraiseCapture(CAPTURE, {
      store,
      vision,
      embedder,
      logger: silentLogger,
      config: { ...DEFAULT_PIPELINE, parallelPricing: 2 },
    });
    expect(peak).toBe(2);
  });
});

describe("privacy", () => {
  it("never reads or saves medications, retainers or remotes next to real items", async () => {
    const store = await setup();
    const vision = fakeVision(
      {
        objects: [
          {
            label: "prescription pill bottle",
            category: "other",
            appearances: [{ frame: 0, box: [0.05, 0.1, 0.2, 0.4] }],
          },
          {
            label: "retainer case",
            category: "other",
            appearances: [{ frame: 0, box: [0.25, 0.1, 0.4, 0.4] }],
          },
          {
            label: "air conditioner remote",
            category: "electronics",
            appearances: [{ frame: 1, box: [0.05, 0.5, 0.2, 0.9] }],
          },
          {
            label: "over-ear headphones",
            category: "electronics",
            appearances: [{ frame: 1, box: [0.5, 0.2, 0.9, 0.8] }],
          },
          {
            label: "white bottle",
            category: "other",
            appearances: [{ frame: 0, box: [0.6, 0.1, 0.75, 0.4] }],
          },
        ],
      },
      [],
    );
    const hints: string[] = [];
    vision.identify = async (_crops, _frame, hint) => {
      hints.push(hint);
      return hint.includes("headphones")
        ? identification({ title: "Sony WH-1000XM4", brand: "Sony", model: "WH-1000XM4" })
        : // The detector's label was vague; identification catches it.
          identification({ title: "Vitamin D3 supplement bottle", brand: null, model: null });
    };
    const saved = await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger });
    expect(hints.sort()).toEqual(["over-ear headphones", "white bottle"]);
    expect(saved).toBe(1);
    expect(store.items.map((i) => i.title)).toEqual(["Sony WH-1000XM4"]);
  });
});

describe("consolidation", () => {
  const twoInOneFrame: Detection = {
    objects: [
      {
        label: "LEGO parts",
        category: "toys/lego",
        appearances: [{ frame: 0, box: [0, 0.2, 0.45, 0.8] }],
      },
      {
        label: "LEGO sheet",
        category: "toys/lego",
        appearances: [{ frame: 0, box: [0.5, 0.2, 0.95, 0.8] }],
      },
    ],
  };
  const lookAlikes = [
    identification({
      title: "LEGO Classic Space Moon Rover Polybag (1980s)",
      model: null,
      identity_confidence: 0.5,
    }),
    identification({
      title: "Vintage LEGO Classic Space Moon Rover Polybag",
      model: null,
      identity_confidence: 0.6,
    }),
  ];

  it("folds look-alikes the model calls 1 thing and keeps the more confident reading", async () => {
    const store = await setup();
    const vision = fakeVision(twoInOneFrame, lookAlikes, true);
    expect(await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger })).toBe(
      1,
    );
    expect(vision.sameCalls).toBe(1);
    expect(store.items[0]?.title).toBe("Vintage LEGO Classic Space Moon Rover Polybag");
  });

  it("keeps both when the model says they are separate", async () => {
    const store = await setup();
    const vision = fakeVision(twoInOneFrame, lookAlikes, false);
    expect(await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger })).toBe(
      2,
    );
  });

  it("does not spend a check on things that look different", async () => {
    const store = await setup();
    const vision = fakeVision(
      twoInOneFrame,
      [
        identification({ title: "Mario Kart 8", brand: "Nintendo", model: null }),
        identification({ title: "Air Jordan 4", brand: "Nike", model: null }),
      ],
      true,
    );
    expect(await appraiseCapture(CAPTURE, { store, vision, embedder, logger: silentLogger })).toBe(
      2,
    );
    expect(vision.sameCalls).toBe(0);
  });

  it("matches on model number or similar titles", () => {
    expect(
      looksAlike(
        identification({ title: "a", model: "6823" }),
        identification({ title: "b", model: "6823 " }),
      ),
    ).toBe(true);
    expect(titleOverlap("LEGO Moon Rover", "lego moon rover set")).toBeCloseTo(0.75);
    expect(
      looksAlike(
        identification({ title: "Zelda", model: null }),
        identification({ title: "Mario", model: null }),
      ),
    ).toBe(false);
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
