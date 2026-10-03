import { describe, expect, it } from "vitest";
import { Box, ValueEstimate } from "../src/appraiser/schemas.js";

describe("schemas", () => {
  it("normalizes and clamps boxes", () => {
    expect(Box.parse([0.8, 1.2, -0.1, 0.3])).toEqual([0, 0.3, 0.8, 1]);
  });

  it("orders a value range low to high", () => {
    const v = ValueEstimate.parse({
      low_usd: 90,
      mid_usd: 70,
      high_usd: 100,
      basis: [],
      confidence: 0.5,
    });
    expect([v.low_usd, v.mid_usd, v.high_usd]).toEqual([70, 90, 100]);
  });
});
