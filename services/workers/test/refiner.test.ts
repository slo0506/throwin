import { computeReadiness, STUDIO_PHOTO_SCORE, YES_NO_OPTIONS } from "@throwin/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CachedPrice } from "../src/appraiser/price-cache.js";
import type { Identification } from "../src/appraiser/schemas.js";
import { silentLogger } from "../src/log.js";
import { CATEGORIES, categoryOf, unknownDrivers } from "../src/refiner/categories.js";
import type { QuestionRequest, RefinerModels } from "../src/refiner/models.js";
import { combine, dropDuplicates, measure, STOCK_PHOTO_CAP } from "../src/refiner/photo-score.js";
import {
  askableDrivers,
  DEFAULT_REFINER,
  normalizeQuestion,
  offersAlternatives,
  type RefineItem,
  type RefinementUpdate,
  type RefinerStore,
  refineItem,
  type StoredQuestion,
} from "../src/refiner/refine.js";
import type { FoldedAnswers, PhotoJudgment, QuestionDraft } from "../src/refiner/schemas.js";
import { cleanDescription, plain } from "../src/refiner/text.js";
import { identification, priceResult, solidJpeg, USER } from "./support.js";

/** A sharp, evenly lit test photo: a checkerboard in 2 mid greys, nothing clipped. */
async function texture(width: number, height: number, cell = 20) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 190 : 70;
      pixels.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toBuffer();
}

const NOW = new Date("2026-10-03T12:00:00Z");
const HOUR = 3_600_000;
/** What models sometimes write and the owner must never see. */
const EM_DASH = String.fromCharCode(0x2014);

const sneaker = identification({
  title: "White high-top sneakers",
  category: "sneakers",
  brand: null,
  model: null,
  variant: null,
  attributes: {},
  identity_confidence: 0.55,
  condition_confidence: 0.6,
  follow_up: "Photo of the size tag",
});

const ps5 = identification({
  title: "PlayStation 5 Slim",
  category: "electronics",
  brand: "Sony",
  model: "PlayStation 5 Slim",
  variant: "Disc edition",
  attributes: { storage: "1TB" },
  identity_confidence: 0.93,
  condition_confidence: 0.85,
});

class MemoryRefinerStore implements RefinerStore {
  files = new Map<string, Buffer>();
  item: RefineItem;
  saved: RefinementUpdate[] = [];
  appraising = true;
  cache = new Map<string, CachedPrice>();

  constructor(item: Partial<RefineItem> & { identification: Identification }) {
    this.item = {
      id: "item-1",
      userId: USER,
      identityConfirmed: false,
      value: null,
      description: null,
      photoScore: null,
      missingAngles: [],
      researchedAt: null,
      media: [{ id: "m0", path: "hero.jpg", position: 0 }],
      questions: [],
      ...item,
    };
  }
  async loadForRefine(itemId: string, userId: string) {
    return itemId === this.item.id && userId === this.item.userId ? this.item : null;
  }
  async download(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`missing ${path}`);
    return f;
  }
  async saveRefinement(_: string, update: RefinementUpdate) {
    this.saved.push(update);
    this.appraising = false;
  }
  async setAppraising(_: string, appraising: boolean) {
    this.appraising = appraising;
  }
  async recordRun() {}
  async getCachedPrice(key: string, grade: string) {
    return this.cache.get(`${key}#${grade}`) ?? null;
  }
  async putCachedPrice(key: string, grade: string, price: CachedPrice) {
    this.cache.set(`${key}#${grade}`, price);
  }
  get last() {
    const u = this.saved.at(-1);
    if (!u) throw new Error("nothing saved");
    return u;
  }
}

const judgment = (overrides: Partial<PhotoJudgment> = {}): PhotoJudgment => ({
  item_visible: true,
  whole_item_in_frame: true,
  fill: 0.6,
  background: "clean",
  angles_present: [],
  main_photo_stock: false,
  extras: [],
  ...overrides,
});

type FakeModels = RefinerModels & {
  calls: { judge: number; research: number; questions: QuestionRequest[]; fold: number };
  judgeImpl: () => PhotoJudgment;
  draft: QuestionDraft;
  folded: FoldedAnswers | null;
};

function fakeModels(): FakeModels {
  return {
    calls: { judge: 0, research: 0, questions: [], fold: 0 },
    judgeImpl: () => judgment(),
    draft: { description: null, questions: [] },
    folded: null,
    async judgePhoto() {
      this.calls.judge++;
      return this.judgeImpl();
    },
    async research() {
      this.calls.research++;
      return "1. Nike Air Force 1 '07 White\n2. Nike Air Force 1 Mid '07 White";
    },
    async writeQuestions(r) {
      this.calls.questions.push(r);
      return this.draft;
    },
    async foldAnswers() {
      this.calls.fold++;
      if (!this.folded) throw new Error("no fold configured");
      return this.folded;
    },
  };
}

function deps(store: MemoryRefinerStore, models: FakeModels, priceMid = 100) {
  let priceCalls = 0;
  return {
    deps: {
      store,
      models,
      logger: silentLogger,
      now: () => NOW,
      pricer: {
        async price() {
          priceCalls++;
          return { ...priceResult(priceMid), cached: false };
        },
      },
    },
    priceCalls: () => priceCalls,
  };
}

const question = (overrides: Partial<StoredQuestion> = {}): StoredQuestion => ({
  id: "q1",
  kind: "yes_no",
  prompt: "Is this Nike?",
  options: [...YES_NO_OPTIONS],
  driver: "brand",
  impact: 0.7,
  status: "open",
  skipCount: 0,
  answer: null,
  foldedAt: null,
  createdAt: new Date(NOW.getTime() - HOUR),
  answeredAt: null,
  ...overrides,
});

describe("refineItem on create", () => {
  it("asks a sneaker with an unknown brand a tap question first, never a photo first", async () => {
    const store = new MemoryRefinerStore({
      identification: sneaker,
      value: { lowCents: 4000, midCents: 6500, highCents: 9000 },
    });
    store.files.set("hero.jpg", await texture(900, 700));
    const models = fakeModels();
    models.draft = {
      description: `White leather high-top sneakers ${EM_DASH} lightly worn. Looks authentic. Clean laces.`,
      questions: [
        {
          driver: "size",
          kind: "photo",
          prompt: "Photo of the size tag",
          options: [],
          impact: 0.9,
        },
        {
          driver: "model",
          kind: "choice",
          prompt: "Which of these is it?",
          options: ["Air Force 1 '07", "Air Force 1 Mid", "Not sure"],
          impact: 0.85,
        },
        { driver: "brand", kind: "yes_no", prompt: "Is this Nike?", options: ["Yes"], impact: 0.7 },
        { driver: "colorway", kind: "text", prompt: "What color?", options: [], impact: 0.3 },
      ],
    };
    const { deps: d } = deps(store, models);
    const outcome = await refineItem("item-1", USER, "created", d);

    expect(outcome).toMatchObject({ status: "refined", readiness: "logged", researched: true });
    // Wide range and mid at least $40: 1 research pass feeds the question writer.
    expect(models.calls.research).toBe(1);
    expect(models.calls.questions[0]?.research).toContain("Air Force 1");
    expect(models.calls.questions[0]?.drivers.map((dr) => dr.key)).toEqual([
      "brand",
      "model",
      "colorway",
      "size",
      "sole_wear",
      "box",
    ]);
    const qs = store.last.newQuestions;
    expect(qs).toHaveLength(3);
    // Ranked by impact over effort: the 1-tap questions lead and the photo comes last,
    // even though the model rated the photo's impact highest.
    expect(qs.map((q) => q.kind)).toEqual(["choice", "yes_no", "photo"]);
    expect(qs.find((q) => q.kind === "choice")?.options).toEqual([
      "Air Force 1 '07",
      "Air Force 1 Mid",
      "Not sure",
    ]);
    expect(qs.find((q) => q.kind === "yes_no")?.options).toEqual(["Yes", "No", "Not sure"]);
    expect(store.last.description).toBe(
      "White leather high-top sneakers, lightly worn. Clean laces.",
    );
    expect(store.last.researchedAt).toEqual(NOW);
    expect(store.last.photo?.score).toBeGreaterThan(0);
    expect(store.appraising).toBe(false);
  });

  it("brings a clear PS5 Slim to identified without questions or research", async () => {
    const store = new MemoryRefinerStore({
      identification: ps5,
      value: { lowCents: 30000, midCents: 34000, highCents: 38000 },
    });
    store.files.set("hero.jpg", await texture(1000, 800));
    const models = fakeModels();
    models.judgeImpl = () => judgment({ angles_present: ["Front"] });
    models.draft = {
      description: "A PlayStation 5 Slim, disc edition, with 1TB of storage. Light use.",
      questions: [
        { driver: "accessories", kind: "yes_no", prompt: "Controller?", options: [], impact: 0.3 },
      ],
    };
    const { deps: d } = deps(store, models);
    const outcome = await refineItem("item-1", USER, "created", d);

    expect(outcome.readiness).toBe("identified");
    expect(models.calls.research).toBe(0);
    // 1 call, for the description only.
    expect(models.calls.questions).toHaveLength(1);
    expect(models.calls.questions[0]).toMatchObject({
      count: 0,
      drivers: [],
      writeDescription: true,
    });
    expect(store.last.newQuestions).toEqual([]);
    expect(store.last.description).toMatch(/^A PlayStation 5 Slim/);
    expect(store.last.photo?.missingAngles).toEqual([
      "Back with label",
      "Ports",
      "Accessories laid out",
    ]);
  });

  it("scores a 180 px crop below 50 with too_small", async () => {
    const store = new MemoryRefinerStore({
      identification: ps5,
      value: { lowCents: 30000, midCents: 34000, highCents: 38000 },
    });
    store.files.set("hero.jpg", await texture(180, 140, 6));
    const models = fakeModels();
    models.judgeImpl = () =>
      judgment({ angles_present: [...CATEGORIES.electronics.angles], fill: 0.9 });
    const { deps: d } = deps(store, models);
    await refineItem("item-1", USER, "created", d);
    expect(store.last.photo?.score).toBeLessThan(50);
    expect(store.last.photo?.issues).toContain("too_small");
  });

  it("never saves a question or description about private things nearby", async () => {
    const store = new MemoryRefinerStore({
      identification: sneaker,
      value: { lowCents: 2000, midCents: 2500, highCents: 3000 },
    });
    store.files.set("hero.jpg", await texture(900, 700));
    const models = fakeModels();
    models.draft = {
      description: "White sneakers next to a prescription bottle.",
      questions: [
        {
          driver: "brand",
          kind: "yes_no",
          prompt: "Are the pill bottles next to it yours?",
          options: [],
          impact: 0.9,
        },
        {
          driver: "model",
          kind: "choice",
          prompt: "Which is it?",
          options: ["Air Force 1", "Vitamins"],
          impact: 0.8,
        },
        { driver: "size", kind: "picker", prompt: "What size?", options: ["9", "10"], impact: 0.5 },
      ],
    };
    const { deps: d } = deps(store, models);
    await refineItem("item-1", USER, "created", d);
    expect(store.last.newQuestions.map((q) => q.driver)).toEqual(["size"]);
    expect(store.last.description).toBeUndefined();
    // Range is narrow-ish but identity is not: no research below $40 mid anyway.
    expect(models.calls.research).toBe(0);
  });
});

describe("refineItem on an answer", () => {
  it("folds a picked candidate, re-prices, pins identity and closes the rest", async () => {
    const store = new MemoryRefinerStore({
      identification: sneaker,
      value: { lowCents: 4000, midCents: 6500, highCents: 9000 },
      photoScore: 42,
      description: "White high-top sneakers.",
      questions: [
        question({
          id: "q-model",
          kind: "choice",
          driver: "model",
          prompt: "Which of these is it?",
          options: ["Air Force 1 '07", "Air Force 1 Mid", "Not sure"],
          status: "answered",
          answer: "Air Force 1 Mid",
          answeredAt: NOW,
        }),
        question({ id: "q-size", kind: "picker", driver: "size", options: ["9", "10"] }),
      ],
    });
    const models = fakeModels();
    models.folded = {
      title: "Nike Air Force 1 Mid '07",
      brand: "Nike",
      model: "Air Force 1 Mid '07",
      variant: "White",
      attributes: [{ name: "model", value: "Air Force 1 Mid '07" }],
      identity_confidence: 0.92,
      product_pinned: true,
      description: "Nike Air Force 1 Mid in white leather. Light creasing on the toe box.",
    };
    // Re-priced to $85 to $135: narrow (at most 1.6 times).
    const { deps: d, priceCalls } = deps(store, models, 110);
    const outcome = await refineItem("item-1", USER, "answer", d);

    expect(models.calls.fold).toBe(1);
    expect(priceCalls()).toBe(1);
    expect(outcome).toMatchObject({ readiness: "identified", repriced: true, folded: 1 });
    expect(store.last).toMatchObject({
      identityConfirmed: true,
      closeOpenQuestions: true,
      foldedQuestionIds: ["q-model"],
      newQuestions: [],
      description: "Nike Air Force 1 Mid in white leather. Light creasing on the toe box.",
    });
    expect(store.last.identification?.brand).toBe("Nike");
    // The photo did not change, so it is not scored again.
    expect(models.calls.judge).toBe(0);
    expect(store.last.photo).toBeUndefined();
  });

  it("treats Not sure and skips as folded without a model call", async () => {
    const store = new MemoryRefinerStore({
      identification: sneaker,
      value: { lowCents: 2000, midCents: 2500, highCents: 3000 },
      photoScore: 30,
      description: "White sneakers.",
      questions: [
        question({ status: "answered", answer: "Not sure", answeredAt: NOW }),
        question({
          id: "q2",
          driver: "size",
          kind: "text",
          options: [],
          status: "skipped",
          skipCount: 1,
          answeredAt: NOW,
        }),
      ],
    });
    const models = fakeModels();
    const { deps: d, priceCalls } = deps(store, models);
    await refineItem("item-1", USER, "answer", d);
    expect(models.calls.fold).toBe(0);
    expect(priceCalls()).toBe(0);
    expect(store.last.foldedQuestionIds.sort()).toEqual(["q1", "q2"]);
    // Brand was answered (Not sure) and size skipped just now: neither is asked again.
    const asked = models.calls.questions[0]?.drivers.map((dr) => dr.key) ?? [];
    expect(asked).not.toContain("brand");
    expect(asked).not.toContain("size");
  });
});

describe("askableDrivers", () => {
  it("never re-asks a driver skipped twice, and waits before re-asking 1 skip", () => {
    const spec = CATEGORIES.sneakers;
    const old = new Date(NOW.getTime() - 100 * HOUR);
    const keys = (qs: StoredQuestion[]) =>
      askableDrivers(spec, sneaker, qs, NOW, DEFAULT_REFINER.reaskAfterHours).map((dr) => dr.key);
    expect(keys([question({ status: "skipped", skipCount: 1, answeredAt: old })])).toContain(
      "brand",
    );
    expect(keys([question({ status: "skipped", skipCount: 1, answeredAt: NOW })])).not.toContain(
      "brand",
    );
    expect(
      keys([
        question({ status: "skipped", skipCount: 1, answeredAt: old }),
        question({ id: "q2", status: "skipped", skipCount: 1, answeredAt: old }),
      ]),
    ).not.toContain("brand");
  });
});

describe("photos that aren't the owner's own Item", () => {
  const angles = CATEGORIES.electronics.angles;

  it("doesn't count an extra photo of something else, and flags it", async () => {
    const big = await texture(1000, 800);
    const m = await measure({ jpeg: big, width: 1000, height: 800 });
    // Found dogfooding: a lens cap from another model "showed" the accessories angle.
    const s = combine(
      m,
      judgment({
        angles_present: ["Front"],
        extras: [
          { shows: "other_item", stock: false, angles: ["Accessories laid out"] },
          { shows: "same_item", stock: false, angles: ["Ports"] },
        ],
      }),
      angles,
    );
    expect(s.missingAngles).toEqual(["Back with label", "Accessories laid out"]);
    expect(s.issues).toContain("wrong_item");
  });

  it("caps a stock-looking main photo below Studio and showcase, and counts none of its angles", async () => {
    const big = await texture(1000, 800);
    const m = await measure({ jpeg: big, width: 1000, height: 800 });
    const s = combine(
      m,
      judgment({ angles_present: [...angles], fill: 0.8, main_photo_stock: true }),
      angles,
    );
    expect(s.score).toBeLessThanOrEqual(STOCK_PHOTO_CAP);
    expect(s.score).toBeLessThan(STUDIO_PHOTO_SCORE);
    expect(s.missingAngles).toEqual([...angles]);
    expect(s.issues).toContain("stock_photo");
  });

  it("ignores a stock extra's angles", async () => {
    const big = await texture(1000, 800);
    const m = await measure({ jpeg: big, width: 1000, height: 800 });
    const s = combine(
      m,
      judgment({ extras: [{ shows: "same_item", stock: true, angles: ["Ports"] }] }),
      angles,
    );
    expect(s.missingAngles).toContain("Ports");
    expect(s.issues).toContain("stock_photo");
  });

  it("finds the same shot added twice, even re-encoded, and keeps different ones", async () => {
    const gradient = (direction: "x" | "y") =>
      sharp(
        Buffer.from(
          Array.from({ length: 200 * 160 }, (_, i) => {
            const x = i % 200;
            const y = Math.floor(i / 200);
            return direction === "x" ? Math.round((x / 199) * 255) : Math.round((y / 159) * 255);
          }),
        ),
        { raw: { width: 200, height: 160, channels: 1 } },
      )
        .jpeg({ quality: 90 })
        .toBuffer();
    const across = await gradient("x");
    const reencoded = await sharp(across).resize(180, 144).jpeg({ quality: 70 }).toBuffer();
    const down = await gradient("y");
    const main = await solidJpeg("#3366aa", 900, 700);
    const { kept, duplicates } = await dropDuplicates(
      { jpeg: main, width: 900, height: 700 },
      [across, reencoded, down].map((jpeg, i) => ({
        image: { jpeg, width: 200, height: 160 },
        value: i,
      })),
    );
    expect(duplicates).toBe(1);
    expect(kept.map((k) => k.value)).toEqual([0, 2]);
  });

  it("judges repeats once and flags them", async () => {
    const store = new MemoryRefinerStore({
      identification: ps5,
      value: { lowCents: 30000, midCents: 34000, highCents: 38000 },
    });
    store.files.set("hero.jpg", await texture(1000, 800));
    const extra = await solidJpeg("#3366aa", 1000, 800);
    store.files.set("extra-1.jpg", extra);
    store.files.set("extra-2.jpg", extra);
    store.item.media.push(
      { id: "m2", path: "extra-1.jpg", position: 1 },
      { id: "m3", path: "extra-2.jpg", position: 2 },
    );
    const models = fakeModels();
    let sent = -1;
    models.judgePhoto = async (_hero, others) => {
      sent = others.length;
      return judgment({ extras: [{ shows: "same_item", stock: false, angles: ["Ports"] }] });
    };
    const { deps: d } = deps(store, models);
    await refineItem("item-1", USER, "photos", d);
    expect(sent).toBe(1);
    expect(store.last.photo?.issues).toContain("duplicate_photo");
  });
});

describe("photo score", () => {
  it("caps small crops at 40 and flags what is wrong", async () => {
    const small = await texture(180, 140, 6);
    const m = await measure({ jpeg: small, width: 180, height: 140 });
    const s = combine(m, judgment({ angles_present: ["Front", "Back", "Any label"] }), [
      "Front",
      "Back",
      "Any label",
    ]);
    expect(s.score).toBeLessThanOrEqual(40);
    expect(s.issues).toEqual(["too_small"]);
  });

  it("scores a large, sharp, clean, fully covered photo at showcase level", async () => {
    const big = await texture(1000, 800);
    const m = await measure({ jpeg: big, width: 1000, height: 800 });
    const angles = CATEGORIES.other.angles;
    const s = combine(m, judgment({ angles_present: [...angles], fill: 0.7 }), angles);
    expect(s.score).toBeGreaterThanOrEqual(75);
    expect(s.missingAngles).toEqual([]);
  });

  it("flags dark, blurry, cut off and cluttered photos", async () => {
    const dark = await solidJpeg("#050505", 1000, 800);
    const m = await measure({ jpeg: dark, width: 1000, height: 800 });
    const s = combine(
      m,
      judgment({ whole_item_in_frame: false, background: "cluttered" }),
      CATEGORIES.sneakers.angles,
    );
    expect(s.issues).toEqual([
      "blurry",
      "dark",
      "cut_off",
      "cluttered_background",
      "missing_angles",
    ]);
    expect(s.score).toBeLessThan(50);
  });
});

describe("questions and text", () => {
  it("enforces options per kind", () => {
    const base = { driver: "brand", prompt: "Is this Nike?", impact: 0.7 };
    expect(normalizeQuestion({ ...base, kind: "yes_no", options: ["Sure"] })?.options).toEqual([
      "Yes",
      "No",
      "Not sure",
    ]);
    expect(normalizeQuestion({ ...base, kind: "choice", options: ["A"] })).toBeNull();
    expect(
      normalizeQuestion({ ...base, kind: "choice", options: ["A", "B", "C", "D", "E", "Not sure"] })
        ?.options,
    ).toEqual(["A", "B", "C", "D", "Not sure"]);
    expect(normalizeQuestion({ ...base, kind: "text", options: ["x"] })?.options).toEqual([]);
    expect(normalizeQuestion({ ...base, kind: "picker", options: [] })).toBeNull();
    expect(
      normalizeQuestion({ ...base, kind: "yes_no", prompt: "Is it authentic?", options: [] }),
    ).toBeNull();
  });

  it("never asks an either/or question with Yes and No answers", () => {
    // Both came from a live Tune up on Oct 3.
    const clog = {
      driver: "model",
      prompt: "Is this the unisex Classic Clog or the Bistro?",
      impact: 0.8,
    };
    expect(
      normalizeQuestion({ ...clog, kind: "yes_no", options: ["Classic Clog", "Bistro"] }),
    ).toEqual({
      ...clog,
      kind: "choice",
      options: ["Classic Clog", "Bistro", "Not sure"],
    });
    // No alternatives named: nothing sensible to offer, so it's dropped.
    const soles = {
      driver: "sole_wear",
      prompt: "Do the soles look fairly intact or heavily worn?",
      impact: 0.5,
    };
    expect(normalizeQuestion({ ...soles, kind: "yes_no", options: [] })).toBeNull();
    expect(normalizeQuestion({ ...soles, kind: "yes_no", options: ["Yes", "No"] })).toBeNull();
    // "Or not" is still a yes/no question.
    expect(
      normalizeQuestion({
        ...soles,
        kind: "yes_no",
        prompt: "Is the box included or not?",
        options: [],
      })?.kind,
    ).toBe("yes_no");
    expect(offersAlternatives("Is this Nike?")).toBe(false);
    expect(offersAlternatives("Nike or Adidas?")).toBe(true);
  });

  it("writes plain text with no em dashes or authenticity claims", () => {
    expect(plain(`Size 10 ${EM_DASH} barely worn`)).toBe("Size 10, barely worn");
    expect(cleanDescription("Genuine Nike sneakers. White leather. Size 10. Light creasing.")).toBe(
      "White leather. Size 10. Light creasing.",
    );
    expect(cleanDescription("100% authentic.")).toBeNull();
  });
});

describe("categories", () => {
  it("maps free-form categories onto the PRD table", () => {
    expect(categoryOf({ category: "sneakers", title: "Air Jordan 1" }).id).toBe("sneakers");
    expect(categoryOf({ category: "video_games", title: "PlayStation 5 Slim console" }).id).toBe(
      "electronics",
    );
    expect(categoryOf({ category: "toys/lego", title: "Typewriter" }).id).toBe("lego");
    expect(categoryOf({ category: "trading_cards", title: "Charizard" }).id).toBe("trading_cards");
    expect(categoryOf({ category: "home", title: "Table lamp" }).id).toBe("other");
  });

  it("counts what identification already knows", () => {
    const keys = unknownDrivers(CATEGORIES.electronics, ps5).map((dr) => dr.key);
    expect(keys).toEqual(["accessories", "battery_health"]);
    expect(
      computeReadiness({
        identityConf: ps5.identity_confidence,
        identityConfirmed: false,
        valueLowCents: 30000,
        valueHighCents: 38000,
        photoScore: null,
        missingAngles: [],
      }),
    ).toBe("identified");
  });
});
