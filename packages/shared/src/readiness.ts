import { z } from "zod";

// Item readiness and Refiner questions (PRD "Item readiness" and "Refinement").
// Readiness is computed on the server only. The Postgres function
// public.compute_item_readiness mirrors computeReadiness below: change both together.

export const ItemReadiness = z.enum(["logged", "identified", "showcase"]);
export type ItemReadiness = z.infer<typeof ItemReadiness>;

/** The only photo issue codes the API returns. */
export const PhotoIssue = z.enum([
  "too_small",
  "blurry",
  "dark",
  "cut_off",
  "cluttered_background",
  "missing_angles",
  /** An extra photo shows something other than this Item; it isn't counted. */
  "wrong_item",
  /** A photo looks like a store or stock image, not the owner's own Item. */
  "stock_photo",
  /** The same shot was added twice; it counts once. */
  "duplicate_photo",
]);
export type PhotoIssue = z.infer<typeof PhotoIssue>;

export const QuestionKind = z.enum(["yes_no", "choice", "picker", "text", "photo"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionStatus = z.enum(["open", "answered", "skipped"]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

/** Identity is confirmed at or above this identity confidence. */
export const IDENTIFIED_CONFIDENCE = 0.85;
/** A range is narrow when high is at most this many times low... */
export const NARROW_RANGE_RATIO = 1.6;
/** ...or when the spread is this small in dollars. A $45 to $75 lamp is narrow enough. */
export const NARROW_RANGE_SPREAD_CENTS = 3000;
/** Photo score needed (with every showcase angle) for showcase. */
export const SHOWCASE_PHOTO_SCORE = 75;
/** Photo score at which Studio is offered. */
export const STUDIO_PHOTO_SCORE = 50;
/** Photo score cap when the crop's long edge is under MIN_LONG_EDGE_PX. */
export const SMALL_PHOTO_CAP = 40;
export const MIN_LONG_EDGE_PX = 600;

/** The fixed options of a yes_no question. */
export const YES_NO_OPTIONS = ["Yes", "No", "Not sure"] as const;
export const NOT_SURE = "Not sure";

/** How much a question asks of the owner (PRD effort table): 1 tap up to a photo. */
export const QUESTION_EFFORT: Record<QuestionKind, number> = {
  yes_no: 1,
  choice: 1,
  picker: 2,
  text: 3,
  photo: 5,
};

export interface ReadinessInput {
  identityConf: number | null;
  /** The owner pinned the product: a question answer or PATCH confirm. */
  identityConfirmed: boolean;
  valueLowCents: number | null;
  valueHighCents: number | null;
  photoScore: number | null;
  missingAngles: readonly string[];
}

export function isNarrowRange(lowCents: number | null, highCents: number | null) {
  if (lowCents === null || highCents === null) return false;
  return (
    highCents <= NARROW_RANGE_RATIO * lowCents || highCents - lowCents <= NARROW_RANGE_SPREAD_CENTS
  );
}

/**
 * identified: identity confirmed (confidence >= 0.85, or pinned by the owner) and a narrow
 * range. showcase: identified, photo score >= 75 and no missing angles. Otherwise logged.
 */
export function computeReadiness(i: ReadinessInput): ItemReadiness {
  const confirmed = i.identityConfirmed || (i.identityConf ?? 0) >= IDENTIFIED_CONFIDENCE;
  if (!confirmed || !isNarrowRange(i.valueLowCents, i.valueHighCents)) return "logged";
  const showcase =
    i.photoScore !== null && i.photoScore >= SHOWCASE_PHOTO_SCORE && i.missingAngles.length === 0;
  return showcase ? "showcase" : "identified";
}

/** Ranking for Tune up: how much an answer would narrow the range per unit of effort. */
export const questionRank = (q: { kind: QuestionKind; impact: number }) =>
  q.impact / QUESTION_EFFORT[q.kind];

/** Best first by impact over effort; older first on ties so the order is stable. */
export function compareQuestions(
  a: { kind: QuestionKind; impact: number; createdAt: Date },
  b: { kind: QuestionKind; impact: number; createdAt: Date },
) {
  return questionRank(b) - questionRank(a) || a.createdAt.getTime() - b.createdAt.getTime();
}
