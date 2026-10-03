/**
 * Deal explanation evals: the Prospector's review of 1 matched Deal (keep or drop, and each
 * person's why), run through the same reviewDeal the worker uses, so the code guards apply.
 */

import { type ReviewModel, type ReviewParticipant, reviewDeal } from "@throwin/workers/eval";
import { z } from "zod";
import type { SnapshotCase } from "./cases.js";

const cents = z.number().int().nonnegative();

const Item = z.strictObject({
  title: z.string(),
  category: z.string().nullable().default(null),
  condition_grade: z.enum(["A", "B", "C", "D"]).nullable().default(null),
  value_low_cents: cents.nullable().default(null),
  value_high_cents: cents.nullable().default(null),
});

const Fact = z.strictObject({ key: z.string(), value: z.string(), category: z.string() });

/** `state.participants`, in Loop order. Refs p1, p2, ... follow this order. */
export const ReviewCaseState = z.strictObject({
  participants: z
    .array(
      z.strictObject({
        first_name: z.string(),
        gives: Item,
        gets: Item,
        pays_cents: cents.default(0),
        receives_cents: cents.default(0),
        facts: z.array(Fact).default([]),
      }),
    )
    .min(2)
    .max(4),
});

const PhrasesByRef = z.record(z.string().regex(/^p[1-4]$/), z.array(z.string()).min(1));

export const ReviewExpect = z.strictObject({
  verdict: z.enum(["keep", "drop"]),
  /** For drops: which layer must catch it. */
  dropped_by: z.enum(["never_trade", "model"]).optional(),
  /** For keeps: every participant ends up with a why that passed the code checks. */
  every_why: z.boolean().optional(),
  /** That person's why mentions at least 1 of these (case-insensitive). */
  why_includes_any: PhrasesByRef.optional(),
  /** That person's why mentions none of these (case-insensitive). */
  why_excludes: PhrasesByRef.optional(),
});

export const isReviewCase = (c: SnapshotCase) => c.suite === "deal_explanation";

export function participantsOf(c: SnapshotCase): ReviewParticipant[] {
  const state = ReviewCaseState.parse(c.state);
  const item = (i: z.infer<typeof Item>) => ({
    title: i.title,
    category: i.category,
    conditionGrade: i.condition_grade,
    valueLowCents: i.value_low_cents,
    valueHighCents: i.value_high_cents,
  });
  return state.participants.map((p, i) => ({
    userId: `p${i + 1}`,
    firstName: p.first_name,
    gives: item(p.gives),
    gets: item(p.gets),
    paysCents: p.pays_cents,
    receivesCents: p.receives_cents,
    facts: p.facts,
  }));
}

export interface ReviewCaseResult {
  pass: boolean;
  failures: string[];
  /** What happened, for the log. */
  summary: string;
}

export async function runReviewCase(
  c: SnapshotCase,
  model: ReviewModel,
): Promise<ReviewCaseResult> {
  const expect = ReviewExpect.parse(c.expect);
  const participants = participantsOf(c);
  const result = await reviewDeal(participants, model);
  const failures: string[] = [];

  if ((result.keep ? "keep" : "drop") !== expect.verdict) {
    failures.push(
      `expected ${expect.verdict}, got ${result.keep ? "keep" : `drop (${result.reason})`}`,
    );
  }
  if (!result.keep) {
    if (expect.dropped_by && result.by !== expect.dropped_by) {
      failures.push(`expected the drop from ${expect.dropped_by}, got ${result.by}`);
    }
    return {
      pass: failures.length === 0,
      failures,
      summary: `drop by ${result.by}: ${result.reason}`,
    };
  }

  // userId is the ref here (participantsOf), so whys are keyed by p1, p2, ...
  const why = (ref: string) => result.whys.get(ref)?.toLowerCase() ?? "";
  if (expect.every_why) {
    const missing = participants.filter((p) => !result.whys.has(p.userId)).map((p) => p.userId);
    if (missing.length) failures.push(`no usable why for ${missing.join(", ")}`);
  }
  for (const [ref, phrases] of Object.entries(expect.why_includes_any ?? {})) {
    if (!phrases.some((p) => why(ref).includes(p.toLowerCase()))) {
      failures.push(
        `${ref}'s why mentions none of ${JSON.stringify(phrases)}: ${JSON.stringify(why(ref))}`,
      );
    }
  }
  for (const [ref, phrases] of Object.entries(expect.why_excludes ?? {})) {
    const hit = phrases.filter((p) => why(ref).includes(p.toLowerCase()));
    if (hit.length)
      failures.push(`${ref}'s why mentions ${JSON.stringify(hit)}: ${JSON.stringify(why(ref))}`);
  }
  const summary = [...result.whys].map(([ref, w]) => `${ref}: ${w}`).join(" | ");
  return { pass: failures.length === 0, failures, summary: `keep. ${summary}` };
}
