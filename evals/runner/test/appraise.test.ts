import type {
  Detection,
  Identification,
  ModelRun,
  PriceResult,
  Vision,
} from "@throwin/workers/eval";
import { silentLogger } from "@throwin/workers/eval";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { noopEmbedder, runCapture, toPredicted } from "../src/appraise.js";
import { CaptureCase } from "../src/cases.js";
import type { Frame } from "../src/frames.js";
import { draftCase, slug } from "../src/label.js";
import { scoreTrial } from "../src/score.js";
import { capture, label } from "./fixtures.js";

const identification = (
  title: string,
  overrides: Partial<Identification> = {},
): Identification => ({
  is_tradeable_item: true,
  title,
  category: "toys/lego",
  brand: "LEGO",
  model: null,
  variant: null,
  attributes: {},
  condition_grade: "B",
  defects: [],
  age_estimate_years: null,
  identity_confidence: 0.9,
  condition_confidence: 0.9,
  follow_up: null,
  ...overrides,
});

const run = (agent: string, costCents: number): ModelRun => ({
  agent,
  model: "fake",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costCents,
  latencyMs: 0,
  outcome: "ok",
});

/**
 * A scripted Vision with a fake clock: 5 boxes, 1 of them a pill bottle (the privacy filter
 * drops it before identification), 1 a wall calendar (a forbidden thing that gets through),
 * and 1 whose pricing fails. No network.
 */
class FakeVision implements Vision {
  static clock = 0;
  constructor(private readonly onRun: (run: ModelRun) => void) {}

  async detect(): Promise<Detection> {
    FakeVision.clock += 1_000;
    this.onRun(run("appraiser.detect", 1));
    const box = (x: number): [number, number, number, number] => [x, 0.2, x + 0.15, 0.6];
    const at = (label: string, frame: number, x: number) => ({
      label,
      category: "other",
      appearances: [{ frame, box: box(x) }],
    });
    return {
      objects: [
        at("LEGO typewriter", 0, 0.05),
        at("wall calendar", 0, 0.6),
        at("LEGO camper", 1, 0.05),
        at("pill bottle", 1, 0.4),
        at("mystery box", 1, 0.75),
      ],
    };
  }

  async identify(_: unknown, __: unknown, hint: string): Promise<Identification> {
    FakeVision.clock += 2_000;
    this.onRun(run("appraiser.identify", 2));
    if (hint === "LEGO typewriter") {
      return identification("LEGO Ideas Typewriter", { model: "21327" });
    }
    if (hint === "LEGO camper") {
      return identification("LEGO Creator Camper Van", {
        identity_confidence: 0.5,
        follow_up: "Box front",
      });
    }
    if (hint === "wall calendar") {
      return identification("2027 wall calendar", { brand: null, category: "other" });
    }
    if (hint === "mystery box") {
      return identification("Mystery box", { brand: null, category: "other" });
    }
    throw new Error(`identify should never see ${hint}`);
  }

  async reidentify(previous: Identification): Promise<Identification> {
    return previous;
  }

  async sameItem() {
    return false;
  }

  async price(item: Identification): Promise<PriceResult> {
    FakeVision.clock += 5_000;
    this.onRun(run("appraiser.price.research", 3));
    if (item.title === "Mystery box") throw new Error("pricing failed");
    const usd = item.title.includes("Typewriter") ? 180 : 40;
    return {
      value: { low_usd: usd * 0.8, mid_usd: usd, high_usd: usd * 1.2, basis: [], confidence: 0.7 },
      research: "fake",
      model: "fake",
    };
  }
}

const fakeDeps = () => {
  FakeVision.clock = 0;
  return {
    makeVision: (onRun: (run: ModelRun) => void) => new FakeVision(onRun),
    embedder: noopEmbedder,
    logger: silentLogger,
    now: () => FakeVision.clock,
  };
};

async function frame(color: string): Promise<Frame> {
  const jpeg = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  return { jpeg, sharpness: 10, source: `${color}.jpg` };
}

describe("runCapture", () => {
  it("runs the real pipeline with a fake Vision, then scores it", async () => {
    const result = await runCapture("c1", [await frame("#c00"), await frame("#0c0")], fakeDeps());
    expect(result.error).toBeNull();
    // Detect (1 s) and 4 identify calls (2 s each) before the first insert, then 4 prices
    // (5 s each) before the last Item is finished.
    expect(result.firstItemMs).toBe(9_000);
    expect(result.latencyMs).toBe(29_000);
    expect(result.predicted.map((p) => p.title).sort()).toEqual([
      "2027 wall calendar",
      "LEGO Creator Camper Van",
      "LEGO Ideas Typewriter",
      "Mystery box",
    ]);
    const typewriter = result.predicted.find((p) => p.model === "21327");
    expect(typewriter?.value).toEqual({ low: 14_400, mid: 18_000, high: 21_600 });
    const camper = result.predicted.find((p) => p.title.includes("Camper"));
    expect(camper).toMatchObject({ status: "needs_photos", follow_up: "Box front" });
    // A failed price still finishes the Item, with no value.
    expect(result.predicted.find((p) => p.title === "Mystery box")?.value).toBeNull();
    expect(result.runs.reduce((a, r) => a + r.costCents, 0)).toBe(1 + 4 * 2 + 4 * 3);

    const shelf = capture({
      items: [
        label({ title: "LEGO Typewriter", model: "21327" }),
        label({
          title: "LEGO Camper Van",
          aliases: ["Creator Camper Van"],
          model: null,
          value_cents_low: 3_000,
          value_cents_high: 5_000,
          should_ask_for_photo: true,
        }),
        label({ title: "Mystery box", brand: null, model: null, category: "other" }),
      ],
      forbidden: ["prescription bottle", "pill bottle", "wall calendar"],
    });
    const score = scoreTrial(shelf, {
      caseId: shelf.id,
      trial: 1,
      predicted: result.predicted,
      latencyMs: result.latencyMs,
      firstItemMs: result.firstItemMs,
      costCents: 21,
      modelRuns: result.runs.length,
      error: null,
    });
    expect(score).toMatchObject({ matched: 3, correct: 2, firstItemMs: 9_000, pass: false });
    expect(score.pairs.find((p) => p.label === "Mystery box")?.predictedRange).toBeNull();
    expect(score.forbiddenHits).toEqual([
      { predicted: "2027 wall calendar", phrase: "wall calendar" },
    ]);
  });

  it("reads each Item from its finish step, not its insert", () => {
    const inserted = identification("LEGO set", { condition_grade: "C" });
    const finished = identification("LEGO Ideas Typewriter", { model: "21327" });
    const base = {
      id: "item-1",
      item: {
        userId: "u",
        captureId: "c",
        status: "on_shelf" as const,
        title: inserted.title,
        identification: inserted,
        cropPath: "x.jpg",
        crop: { jpeg: Buffer.alloc(0), width: 1, height: 1 },
      },
      appraising: false,
      insertedAt: 0,
    };
    expect(toPredicted({ ...base, priced: null, finishedAt: null })).toMatchObject({
      title: "LEGO set",
      condition_grade: "C",
      value: null,
    });
    const priced = {
      identification: finished,
      value: { low_usd: 150, mid_usd: 180, high_usd: 210.555, basis: [], confidence: 0.8 },
      model: "fake",
      comps: { research: "", basis: [], cached: false },
    };
    expect(toPredicted({ ...base, priced, finishedAt: 5 })).toMatchObject({
      title: "LEGO Ideas Typewriter",
      model: "21327",
      condition_grade: "B",
      value: { low: 15_000, mid: 18_000, high: 21_056 },
    });
  });

  it("reports a pipeline failure as an error instead of throwing", async () => {
    const result = await runCapture("c2", [], fakeDeps());
    expect(result.error).toMatch(/no media/);
    expect(result.predicted).toEqual([]);
  });
});

describe("label assist", () => {
  it("writes a valid draft with every label unreviewed", async () => {
    const result = await runCapture("c3", [await frame("#c00"), await frame("#0c0")], fakeDeps());
    const draft = draftCase(slug("Living Room 01"), ["Living Room 01"], result.predicted);
    expect(draft.id).toBe("appraisal-living-room-01");
    expect(draft.items).toHaveLength(4);
    expect(draft.items.find((i) => i.title === "Mystery box")?.notes).toMatch(/no price/);
    expect(draft.items.every((i) => i.reviewed === false)).toBe(true);
    expect(draft.items.find((i) => i.model === "21327")).toMatchObject({
      value_cents_low: 14_400,
      value_cents_high: 21_600,
      should_ask_for_photo: false,
    });
    expect(CaptureCase.safeParse(JSON.parse(JSON.stringify(draft))).success).toBe(true);
  });

  it("fills a zero range with a note when pricing failed", () => {
    const draft = draftCase(
      "x",
      ["x"],
      [
        {
          title: "Mystery box",
          category: "other",
          brand: null,
          model: null,
          condition_grade: "C",
          status: "needs_photos",
          follow_up: null,
          value: null,
        },
      ],
    );
    expect(draft.items[0]).toMatchObject({ value_cents_low: 0, value_cents_high: 0 });
    expect(draft.items[0]?.notes).toMatch(/no price/);
  });
});
