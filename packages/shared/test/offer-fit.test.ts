import { describe, expect, it } from "vitest";
import { itemVerdict, offerFit } from "../src/offer-fit.js";

describe("offerFit", () => {
  it("judges the best single Item plus cash, never the sum", () => {
    // A used PS4 at about $125: 3 small Items that add up past it still don't fit alone.
    const small = [
      { id: "asics", midCents: 3000 },
      { id: "crocs", midCents: 2000 },
      { id: "plant", midCents: 1500 },
    ];
    expect(offerFit(12500, small, 0)).toEqual({
      // $125 less the $18.75 tolerance less $30 is $76.25 short, shown as about $80.
      verdict: { kind: "short", cents: 8000 },
      bestId: "asics",
    });
    expect(offerFit(12500, [...small, { id: "switch", midCents: 11000 }], 0)).toEqual({
      verdict: { kind: "fits" },
      bestId: "switch",
    });
  });

  it("covers a gap with cash within the ceiling, rounded up to $5", () => {
    // $125 less the $18.75 tolerance less $90 needs $16.25 of cash, shown as about $20.
    expect(itemVerdict(9000, 12500, 2000)).toEqual({ kind: "fits_with_cash", cents: 2000 });
    expect(itemVerdict(9000, 12500, 1000)).toEqual({ kind: "short", cents: 1000 });
  });

  it("says when the offer is worth clearly more, and handles no price or no offer", () => {
    expect(itemVerdict(23000, 12500, 0)).toEqual({ kind: "worth_more" });
    expect(offerFit(null, [{ id: "a", midCents: 100 }], 0).verdict).toEqual({ kind: "pricing" });
    expect(offerFit(12500, [{ id: "a", midCents: null }], 0).verdict).toEqual({ kind: "empty" });
  });
});
