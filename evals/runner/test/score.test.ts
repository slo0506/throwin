import { describe, expect, it } from "vitest";
import type { PredictedItem } from "../src/match.js";
import { renderReport } from "../src/report.js";
import { percentile, scoreTrial, summarize, type TrialResult } from "../src/score.js";
import { capture, label, predicted } from "./fixtures.js";

/** A shelf of 10 labeled Items: "Widget 1 deluxe" to "Widget 10 deluxe", each $10 to $20. */
const shelf = capture({
  items: Array.from({ length: 10 }, (_, i) =>
    label({
      title: `Widget ${i + 1} deluxe`,
      brand: "Acme",
      model: null,
      value_cents_low: 1_000,
      value_cents_high: 2_000,
    }),
  ),
  forbidden: ["prescription bottle"],
});

const guess = (n: number, overrides: Partial<PredictedItem> = {}) =>
  predicted({
    title: `Widget ${n} deluxe`,
    brand: "Acme",
    model: null,
    value: { low: 1_500, mid: 1_800, high: 2_500 },
    ...overrides,
  });

const result = (predictedItems: PredictedItem[], overrides: Partial<TrialResult> = {}) => ({
  caseId: shelf.id,
  trial: 1,
  predicted: predictedItems,
  latencyMs: 30_000,
  costCents: 10,
  modelRuns: 12,
  error: null,
  ...overrides,
});

describe("scoreTrial", () => {
  it("passes at exactly 8 of 10 correct under 60 seconds", () => {
    const preds = Array.from({ length: 8 }, (_, i) => guess(i + 1));
    const s = scoreTrial(shelf, result(preds));
    expect(s).toMatchObject({ labeled: 10, predicted: 8, matched: 8, correct: 8, pass: true });
    expect(s.missed).toEqual(["Widget 9 deluxe", "Widget 10 deluxe"]);
  });

  it("does not count a match whose range misses the label as correct", () => {
    const preds = Array.from({ length: 8 }, (_, i) =>
      guess(i + 1, i === 0 ? { value: { low: 5_000, mid: 6_000, high: 7_000 } } : {}),
    );
    const s = scoreTrial(shelf, result(preds));
    expect(s).toMatchObject({ matched: 8, correct: 7, pass: false });
    expect(s.pairs[0]).toMatchObject({ rangeOverlaps: false, predictedRange: [5_000, 7_000] });
  });

  it("does not count a match without a price as correct", () => {
    const s = scoreTrial(shelf, result([guess(1, { value: null })]));
    expect(s).toMatchObject({ matched: 1, correct: 0 });
  });

  it("fails at 60 seconds or on an error, whatever the accuracy", () => {
    const all = Array.from({ length: 10 }, (_, i) => guess(i + 1));
    expect(scoreTrial(shelf, result(all, { latencyMs: 60_000 })).pass).toBe(false);
    expect(scoreTrial(shelf, result(all, { error: "boom" })).pass).toBe(false);
    expect(scoreTrial(shelf, result(all, { latencyMs: 59_999 })).pass).toBe(true);
  });

  it("splits unmatched predictions into forbidden hits and extras", () => {
    const s = scoreTrial(
      shelf,
      result([
        guess(1),
        predicted({ title: "Prescription bottle", brand: null, model: null }),
        predicted({ title: "Desk lamp", brand: null, model: null }),
      ]),
    );
    expect(s.forbiddenHits).toEqual([
      { predicted: "Prescription bottle", phrase: "prescription bottle" },
    ]);
    expect(s.extra).toEqual(["Desk lamp"]);
  });

  it("checks condition grade and follow-up photo agreement on matches", () => {
    const l = capture({ items: [label({ should_ask_for_photo: true, condition_grade: "A" })] });
    const s = scoreTrial(l, { ...result([predicted({ status: "needs_photos" })]), caseId: l.id });
    expect(s.pairs[0]).toMatchObject({ conditionAgrees: false, followUpAgrees: true });
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.9)).toBe(90);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("summarize", () => {
  const good = Array.from({ length: 9 }, (_, i) => guess(i + 1));
  const bad = Array.from({ length: 5 }, (_, i) => guess(i + 1));

  it("passes a capture when more than half its trials pass, and computes the totals", () => {
    const scores = [
      scoreTrial(shelf, result(good, { trial: 1, latencyMs: 20_000, costCents: 9 })),
      scoreTrial(shelf, result(good, { trial: 2, latencyMs: 40_000, costCents: 9 })),
      scoreTrial(shelf, result(bad, { trial: 3, latencyMs: 70_000, costCents: 5 })),
    ];
    const s = summarize(scores);
    expect(s.cases[0]).toMatchObject({ passedTrials: 2, pass: true });
    expect(s).toMatchObject({ labeled: 30, predicted: 23, matched: 23, correct: 23 });
    expect(s.precision).toBe(1);
    expect(s.recall).toBeCloseTo(23 / 30);
    expect(s.rangeOverlapRate).toBe(1);
    expect(s.latencyMedianMs).toBe(40_000);
    expect(s.latencyP90Ms).toBe(70_000);
    expect(s.costPerItemCents).toBeCloseTo(23 / 23);
    expect(s.costPerCaptureCents).toBeCloseTo(23 / 3);
    expect(s.pass).toBe(true);
  });

  it("fails the M1 gate when a capture fails most trials", () => {
    const s = summarize([
      scoreTrial(shelf, result(good, { trial: 1 })),
      scoreTrial(shelf, result(bad, { trial: 2 })),
    ]);
    expect(s.cases[0]?.pass).toBe(false);
    expect(s.gates[0]?.pass).toBe(false);
    expect(s.pass).toBe(false);
  });

  it("fails the forbidden gate on a single hit, even when accuracy passes", () => {
    const hit = predicted({ title: "Prescription bottle", brand: null, model: null });
    const s = summarize([scoreTrial(shelf, result([...good, hit]))]);
    expect(s.gates[0]?.pass).toBe(true);
    expect(s.gates[1]).toMatchObject({ actual: "1", pass: false });
    expect(s.pass).toBe(false);
  });

  it("fails with no captures at all", () => {
    expect(summarize([]).pass).toBe(false);
  });

  it("renders a markdown report with the gates and every capture", () => {
    const s = summarize([scoreTrial(shelf, result(good))]);
    const md = renderReport(s, {
      casesDir: "evals/cases/appraisal",
      trials: 1,
      skipped: ["appraisal-lego-set-is-one-item"],
      embedder: "none",
      startedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(md).toContain("**Result:** PASS");
    expect(md).toContain("| appraisal-test-shelf #1 | 1 of 1 | 9 of 10 |");
    expect(md).toContain("$10 to $20");
    expect(md).toContain("- appraisal-lego-set-is-one-item");
    expect(md).not.toContain(String.fromCharCode(0x2014));
  });
});
