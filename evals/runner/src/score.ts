import type { CaptureCase } from "./cases.js";
import { forbiddenHit, matchItems, type PredictedItem, rangesOverlap } from "./match.js";

/** Milestone 1: "at least 8 correct Items with ranges" from a shelf of 10. */
export const M1_CORRECT_SHARE = 0.8;
/** Milestone 1: "in under 60 seconds". */
export const M1_LATENCY_MS = 60_000;
/** Forbidden things (medicine, a remote that belongs to the house) must never become Items. */
export const MAX_FORBIDDEN_HITS = 0;

/** 1 run of the Appraiser on 1 capture. */
export interface TrialResult {
  caseId: string;
  trial: number;
  predicted: PredictedItem[];
  /** From loading the capture to the last Item finished with its value. */
  latencyMs: number;
  /** From loading the capture to the first Item on the Shelf, still unpriced. */
  firstItemMs?: number | null;
  /** Sum of every recorded model run. Fractional cents, as `agent_runs.cost_cents`. */
  costCents: number;
  modelRuns: number;
  error: string | null;
}

export interface MatchedPair {
  label: string;
  predicted: string;
  score: number;
  labelRange: [number, number];
  predictedRange: [number, number] | null;
  rangeOverlaps: boolean;
  conditionAgrees: boolean;
  followUpAgrees: boolean;
}

export interface TrialScore {
  caseId: string;
  trial: number;
  labeled: number;
  predicted: number;
  matched: number;
  /** Matched and the value range overlaps the labeled range. */
  correct: number;
  pairs: MatchedPair[];
  missed: string[];
  /** Predictions that match no label and no forbidden entry. */
  extra: string[];
  forbiddenHits: { predicted: string; phrase: string }[];
  latencyMs: number;
  firstItemMs: number | null;
  costCents: number;
  error: string | null;
  /** Correct share at or above 80% and under 60 seconds, without an error. */
  pass: boolean;
}

export function scoreTrial(c: CaptureCase, r: TrialResult): TrialScore {
  const { matches, missed, unmatched } = matchItems(r.predicted, c.items);
  const pairs: MatchedPair[] = matches.map((m) => {
    const p = r.predicted[m.predicted] as PredictedItem;
    const l = c.items[m.label] as CaptureCase["items"][number];
    const labelRange = { low: l.value_cents_low, high: l.value_cents_high };
    return {
      label: l.title,
      predicted: p.title,
      score: m.score,
      labelRange: [labelRange.low, labelRange.high],
      predictedRange: p.value ? [p.value.low, p.value.high] : null,
      rangeOverlaps: p.value !== null && rangesOverlap(p.value, labelRange),
      conditionAgrees: p.condition_grade === l.condition_grade,
      followUpAgrees: (p.follow_up !== null) === l.should_ask_for_photo,
    };
  });
  const forbiddenHits: TrialScore["forbiddenHits"] = [];
  const extra: string[] = [];
  for (const i of unmatched) {
    const p = r.predicted[i] as PredictedItem;
    const phrase = forbiddenHit(p, c.forbidden);
    if (phrase) forbiddenHits.push({ predicted: p.title, phrase });
    else extra.push(p.title);
  }
  const correct = pairs.filter((p) => p.rangeOverlaps).length;
  const labeled = c.items.length;
  const share = labeled > 0 ? correct / labeled : 1;
  return {
    caseId: c.id,
    trial: r.trial,
    labeled,
    predicted: r.predicted.length,
    matched: pairs.length,
    correct,
    pairs,
    missed: missed.map((i) => (c.items[i] as CaptureCase["items"][number]).title),
    extra,
    forbiddenHits,
    latencyMs: r.latencyMs,
    firstItemMs: r.firstItemMs ?? null,
    costCents: r.costCents,
    error: r.error,
    pass: r.error === null && share >= M1_CORRECT_SHARE && r.latencyMs < M1_LATENCY_MS,
  };
}

/** Nearest-rank percentile (p from 0 to 1). 0 for an empty list. */
export function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface CaseSummary {
  caseId: string;
  trials: TrialScore[];
  passedTrials: number;
  /** More than half of the trials pass (2 of 3, 1 of 1). */
  pass: boolean;
}

export interface Summary {
  cases: CaseSummary[];
  trials: number;
  labeled: number;
  predicted: number;
  matched: number;
  correct: number;
  precision: number | null;
  recall: number | null;
  correctRate: number | null;
  rangeOverlapRate: number | null;
  conditionAgreement: number | null;
  followUpAgreement: number | null;
  forbiddenHits: number;
  errors: number;
  latencyMedianMs: number;
  latencyP90Ms: number;
  /** Median time to the first Item on the Shelf, over trials that saved any. */
  firstItemMedianMs: number | null;
  costCents: number;
  costPerItemCents: number | null;
  costPerCaptureCents: number | null;
  gates: { name: string; target: string; actual: string; pass: boolean }[];
  pass: boolean;
}

export function summarize(scores: TrialScore[]): Summary {
  const byCase = new Map<string, TrialScore[]>();
  for (const s of scores) byCase.set(s.caseId, [...(byCase.get(s.caseId) ?? []), s]);
  const cases: CaseSummary[] = [...byCase.entries()].map(([caseId, trials]) => {
    const passedTrials = trials.filter((t) => t.pass).length;
    return { caseId, trials, passedTrials, pass: passedTrials * 2 > trials.length };
  });

  const total = (f: (s: TrialScore) => number) => sum(scores.map(f));
  const labeled = total((s) => s.labeled);
  const predicted = total((s) => s.predicted);
  const matched = total((s) => s.matched);
  const correct = total((s) => s.correct);
  const pairs = scores.flatMap((s) => s.pairs);
  const forbiddenHits = total((s) => s.forbiddenHits.length);
  const costCents = total((s) => s.costCents);
  const latencies = scores.map((s) => s.latencyMs);
  const firstItems = scores.flatMap((s) => (s.firstItemMs === null ? [] : [s.firstItemMs]));
  const passedCases = cases.filter((c) => c.pass).length;

  const gates = [
    {
      name: "M1: at least 80% of labeled Items correct, under 60 s, per capture",
      target: `${cases.length} of ${cases.length} captures`,
      actual: `${passedCases} of ${cases.length} captures`,
      pass: cases.length > 0 && passedCases === cases.length,
    },
    {
      name: "Forbidden things saved as Items",
      target: `${MAX_FORBIDDEN_HITS}`,
      actual: `${forbiddenHits}`,
      pass: forbiddenHits <= MAX_FORBIDDEN_HITS,
    },
  ];

  return {
    cases,
    trials: scores.length,
    labeled,
    predicted,
    matched,
    correct,
    precision: ratio(matched, predicted),
    recall: ratio(matched, labeled),
    correctRate: ratio(correct, labeled),
    rangeOverlapRate: ratio(correct, matched),
    conditionAgreement: ratio(pairs.filter((p) => p.conditionAgrees).length, pairs.length),
    followUpAgreement: ratio(pairs.filter((p) => p.followUpAgrees).length, pairs.length),
    forbiddenHits,
    errors: scores.filter((s) => s.error !== null).length,
    latencyMedianMs: percentile(latencies, 0.5),
    latencyP90Ms: percentile(latencies, 0.9),
    firstItemMedianMs: firstItems.length > 0 ? percentile(firstItems, 0.5) : null,
    costCents,
    costPerItemCents: ratio(costCents, predicted),
    costPerCaptureCents: ratio(costCents, scores.length),
    gates,
    pass: gates.every((g) => g.pass),
  };
}
