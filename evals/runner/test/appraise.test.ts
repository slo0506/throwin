import type { Detection, Identification, ModelRun, Vision } from "@throwin/workers/eval";
import { silentLogger } from "@throwin/workers/eval";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { noopEmbedder, runCapture } from "../src/appraise.js";
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

/** A scripted Vision: 3 boxes, 1 of them a pill bottle, priced from a table. No network. */
class FakeVision implements Vision {
  constructor(private readonly onRun: (run: ModelRun) => void) {}

  async detect(): Promise<Detection> {
    this.onRun(run("appraiser.detect", 1));
    const box = (x: number): [number, number, number, number] => [x, 0.2, x + 0.2, 0.6];
    return {
      objects: [
        { label: "LEGO typewriter", category: "toys", appearances: [{ frame: 0, box: box(0.05) }] },
        { label: "LEGO camper", category: "toys", appearances: [{ frame: 1, box: box(0.4) }] },
        { label: "pill bottle", category: "other", appearances: [{ frame: 1, box: box(0.75) }] },
      ],
    };
  }

  async identify(_: unknown, __: unknown, hint: string): Promise<Identification> {
    this.onRun(run("appraiser.identify", 2));
    if (hint === "LEGO typewriter")
      return identification("LEGO Ideas Typewriter", { model: "21327" });
    if (hint === "LEGO camper") {
      return identification("LEGO Creator Camper Van", {
        identity_confidence: 0.5,
        follow_up: "Box front",
      });
    }
    return identification("Prescription pill bottle", { brand: null, category: "other" });
  }

  async sameItem() {
    return false;
  }

  async price(item: Identification) {
    this.onRun(run("appraiser.price.research", 3));
    const usd = item.title.includes("Typewriter") ? 180 : 40;
    return {
      value: { low_usd: usd * 0.8, mid_usd: usd, high_usd: usd * 1.2, basis: [], confidence: 0.7 },
      research: "fake",
    };
  }
}

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
    let clock = 0;
    const result = await runCapture("c1", [await frame("#c00"), await frame("#0c0")], {
      makeVision: (onRun) => new FakeVision(onRun),
      embedder: noopEmbedder,
      logger: silentLogger,
      now: () => (clock += 1_500),
    });
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBe(1_500);
    expect(result.predicted.map((p) => p.title).sort()).toEqual([
      "LEGO Creator Camper Van",
      "LEGO Ideas Typewriter",
      "Prescription pill bottle",
    ]);
    const typewriter = result.predicted.find((p) => p.model === "21327");
    expect(typewriter?.value).toEqual({ low: 14_400, mid: 18_000, high: 21_600 });
    const camper = result.predicted.find((p) => p.title.includes("Camper"));
    expect(camper).toMatchObject({ status: "needs_photos", follow_up: "Box front" });
    expect(result.runs.reduce((a, r) => a + r.costCents, 0)).toBe(1 + 3 * 2 + 3 * 3);

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
      ],
      forbidden: ["prescription bottle", "pill bottle"],
    });
    const score = scoreTrial(shelf, {
      caseId: shelf.id,
      trial: 1,
      predicted: result.predicted,
      latencyMs: result.latencyMs,
      costCents: 16,
      modelRuns: result.runs.length,
      error: null,
    });
    expect(score).toMatchObject({ matched: 2, correct: 2, pass: true });
    expect(score.pairs.every((p) => p.followUpAgrees)).toBe(true);
    expect(score.forbiddenHits).toHaveLength(1);
  });

  it("reports a pipeline failure as an error instead of throwing", async () => {
    const result = await runCapture("c2", [], {
      makeVision: (onRun) => new FakeVision(onRun),
      embedder: noopEmbedder,
      logger: silentLogger,
    });
    expect(result.error).toMatch(/no media/);
    expect(result.predicted).toEqual([]);
  });
});

describe("label assist", () => {
  it("writes a valid draft with every label unreviewed", async () => {
    const result = await runCapture("c3", [await frame("#c00"), await frame("#0c0")], {
      makeVision: (onRun) => new FakeVision(onRun),
      embedder: noopEmbedder,
      logger: silentLogger,
    });
    const draft = draftCase(slug("Living Room 01"), ["Living Room 01"], result.predicted);
    expect(draft.id).toBe("appraisal-living-room-01");
    expect(draft.items).toHaveLength(3);
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
