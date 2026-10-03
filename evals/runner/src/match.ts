import type { LabeledItem } from "./cases.js";

/** What the Appraiser produced for 1 Item, in the shape scoring needs. */
export interface PredictedItem {
  title: string;
  category: string;
  brand: string | null;
  model: string | null;
  condition_grade: "A" | "B" | "C" | "D";
  /** The photo the Appraiser would want. Set means it was unsure: the Refiner asks about it. */
  follow_up: string | null;
  /** Null when pricing failed. Integer cents. */
  value: { low: number; mid: number; high: number } | null;
}

/**
 * A prediction and a label match at or above this score. Score is the Dice coefficient of
 * their token sets (2 x shared / total), so 0.5 means half of all the words line up, e.g.
 * "Nike Air Jordan 1 High" against "Air Jordan 1 Retro High OG" plus brand "Nike" scores
 * 0.83, while "Nike Air Max 90" against the same label scores 0.36.
 */
export const MATCH_THRESHOLD = 0.5;
/** A model or set number that agrees on both sides lifts the score to at least this. */
export const MODEL_AGREES_SCORE = 0.75;

const STOPWORDS = new Set(["a", "an", "and", "the", "of", "with", "for", "in", "on", "by"]);

/** Lowercase, accent-free words and numbers. Single letters are dropped, single digits kept. */
export function tokens(...parts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const words = part
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u);
    for (const w of words) {
      if (!w || STOPWORDS.has(w)) continue;
      if (w.length === 1 && !/\d/.test(w)) continue;
      out.add(w);
    }
  }
  return out;
}

export function dice(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return (2 * shared) / (a.size + b.size);
}

const normModel = (m: string | null | undefined) =>
  m ? m.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") || null : null;

/**
 * How well a prediction names a labeled Item, 0 to 1. Compares the prediction's title,
 * brand and model with the label's title and with each alias (each plus brand and model),
 * and keeps the best. 2 different model numbers veto the match outright (2 LEGO Star Wars
 * sets share most of their words); the same model number lifts it.
 */
export function matchScore(p: PredictedItem, l: LabeledItem): number {
  const [pm, lm] = [normModel(p.model), normModel(l.model)];
  if (pm && lm && !pm.includes(lm) && !lm.includes(pm)) return 0;
  const predicted = tokens(p.title, p.brand, p.model);
  let best = 0;
  for (const name of [l.title, ...l.aliases]) {
    best = Math.max(best, dice(predicted, tokens(name, l.brand, l.model)));
  }
  if (pm && lm && (pm.includes(lm) || lm.includes(pm))) best = Math.max(best, MODEL_AGREES_SCORE);
  return best;
}

/** True when the categories share a word ("toys/lego" and "toys"). Used only to break ties. */
export function categoryAgrees(a: string, b: string) {
  const ta = tokens(a);
  for (const w of tokens(b)) if (ta.has(w)) return true;
  return false;
}

export interface Match {
  predicted: number;
  label: number;
  score: number;
}

/**
 * 1-to-1 assignment, greedy by score: take the best remaining pair at or above the
 * threshold, then the next, never reusing either side. Ties go to the pair whose
 * categories agree, then to the lower indices, so results are deterministic.
 */
export function matchItems(
  predicted: PredictedItem[],
  labels: LabeledItem[],
  threshold = MATCH_THRESHOLD,
) {
  const pairs: (Match & { category: boolean })[] = [];
  predicted.forEach((p, pi) => {
    labels.forEach((l, li) => {
      const score = matchScore(p, l);
      if (score >= threshold) {
        pairs.push({
          predicted: pi,
          label: li,
          score,
          category: categoryAgrees(p.category, l.category),
        });
      }
    });
  });
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.category) - Number(a.category) ||
      a.label - b.label ||
      a.predicted - b.predicted,
  );
  const usedP = new Set<number>();
  const usedL = new Set<number>();
  const matches: Match[] = [];
  for (const pair of pairs) {
    if (usedP.has(pair.predicted) || usedL.has(pair.label)) continue;
    usedP.add(pair.predicted);
    usedL.add(pair.label);
    matches.push({ predicted: pair.predicted, label: pair.label, score: pair.score });
  }
  matches.sort((a, b) => a.label - b.label);
  return {
    matches,
    missed: labels.map((_, i) => i).filter((i) => !usedL.has(i)),
    unmatched: predicted.map((_, i) => i).filter((i) => !usedP.has(i)),
  };
}

/**
 * A forbidden entry is hit when every one of its words appears in the prediction's title,
 * category, brand or model. Strict on purpose ("bottle" alone must not flag a water
 * bottle), so list several phrasings: "prescription bottle", "pill bottle".
 */
export function forbiddenHit(p: PredictedItem, forbidden: string[]): string | null {
  const have = tokens(p.title, p.category, p.brand, p.model);
  for (const phrase of forbidden) {
    const need = tokens(phrase);
    if (need.size > 0 && [...need].every((w) => have.has(w))) return phrase;
  }
  return null;
}

/** Inclusive overlap of 2 cent ranges. */
export const rangesOverlap = (a: { low: number; high: number }, b: { low: number; high: number }) =>
  a.low <= b.high && b.low <= a.high;
