import type { CaptureCase, LabeledItem } from "../src/cases.js";
import type { PredictedItem } from "../src/match.js";

export const label = (overrides: Partial<LabeledItem> = {}): LabeledItem => ({
  title: "LEGO Typewriter",
  aliases: [],
  category: "toys/lego",
  brand: "LEGO",
  model: "21327",
  condition_grade: "B",
  value_cents_low: 15_000,
  value_cents_high: 22_000,
  should_ask_for_photo: false,
  reviewed: true,
  ...overrides,
});

export const predicted = (overrides: Partial<PredictedItem> = {}): PredictedItem => ({
  title: "LEGO Ideas Typewriter 21327",
  category: "toys/lego",
  brand: "LEGO",
  model: "21327",
  condition_grade: "B",
  follow_up: null,
  value: { low: 18_000, mid: 20_000, high: 24_000 },
  ...overrides,
});

export const capture = (overrides: Partial<CaptureCase> = {}): CaptureCase => ({
  version: 2,
  id: "appraisal-test-shelf",
  suite: "appraisal",
  description: "A test shelf",
  media: ["test-shelf"],
  items: [label()],
  forbidden: [],
  ...overrides,
});
