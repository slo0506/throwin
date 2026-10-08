// Whether an Ask's offer can pay for what it's after. Each person must come out within the
// matcher's tolerance (15% of the larger side or $10, whichever is more;
// docs/contracts/m3-matcher.md). Most Deals swap 1 Item each way plus cash; the matcher adds
// more of the offer only when the other side wants several, which nobody can count on. So
// what counts is the best single Item plus the cash ceiling, never the sum of the offer. The
// iOS Ask page runs the same rules on device (OfferFit.swift) so it can answer as you tap.

export const OFFER_TOLERANCE_PCT = 0.15;
export const OFFER_TOLERANCE_FLOOR_CENTS = 1000;

export type OfferVerdict =
  | { kind: "pricing" }
  | { kind: "empty" }
  | { kind: "fits" }
  | { kind: "fits_with_cash"; cents: number }
  | { kind: "worth_more" }
  | { kind: "short"; cents: number };

export interface OfferCandidate {
  id: string;
  /** Null while the Item is still being priced. */
  midCents: number | null;
}

export const offerTolerance = (a: number, b: number) =>
  Math.max(Math.round(Math.max(a, b) * OFFER_TOLERANCE_PCT), OFFER_TOLERANCE_FLOOR_CENTS);

/** Up to the next $5: estimates shouldn't look precise. */
const roundUp = (cents: number) => (cents <= 0 ? 0 : Math.ceil(cents / 500) * 500);

/** How 1 Item does against the target on its own, with up to `ceilingCents` of cash. */
export function itemVerdict(valueCents: number, targetCents: number, ceilingCents: number) {
  const tolerance = offerTolerance(targetCents, valueCents);
  if (valueCents > targetCents + tolerance) return { kind: "worth_more" } as const;
  if (valueCents >= targetCents - tolerance) return { kind: "fits" } as const;
  const need = targetCents - tolerance - valueCents;
  if (need <= ceilingCents) return { kind: "fits_with_cash", cents: roundUp(need) } as const;
  return { kind: "short", cents: roundUp(need - ceilingCents) } as const;
}

const RANK: Record<OfferVerdict["kind"], number> = {
  fits: 0,
  fits_with_cash: 1,
  worth_more: 2,
  short: 3,
  pricing: 4,
  empty: 4,
};

/** The verdict for the best Item in the offer, and which Item that is. */
export function offerFit(
  targetMidCents: number | null,
  offered: OfferCandidate[],
  ceilingCents: number,
): { verdict: OfferVerdict; bestId: string | null } {
  if (targetMidCents === null) return { verdict: { kind: "pricing" }, bestId: null };
  let best: { verdict: OfferVerdict; bestId: string; key: [number, number] } | null = null;
  for (const item of offered) {
    if (item.midCents === null) continue;
    const verdict = itemVerdict(item.midCents, targetMidCents, ceilingCents);
    const tiebreak =
      verdict.kind === "fits_with_cash" || verdict.kind === "short"
        ? verdict.cents
        : Math.abs(item.midCents - targetMidCents);
    const key: [number, number] = [RANK[verdict.kind], tiebreak];
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
      best = { verdict, bestId: item.id, key };
    }
  }
  return best
    ? { verdict: best.verdict, bestId: best.bestId }
    : { verdict: { kind: "empty" }, bestId: null };
}
