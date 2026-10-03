import { describe, expect, it } from "vitest";
import { compareQuestions, computeReadiness, questionRank } from "../src/readiness.js";

const base = {
  identityConf: 0.9,
  identityConfirmed: false,
  valueLowCents: 10_000,
  valueHighCents: 15_000,
  photoScore: 80,
  missingAngles: [] as string[],
};

describe("computeReadiness", () => {
  it("is showcase when identified with a showcase photo set", () => {
    expect(computeReadiness(base)).toBe("showcase");
  });

  it("is identified when the photo bar is not met", () => {
    expect(computeReadiness({ ...base, photoScore: 74 })).toBe("identified");
    expect(computeReadiness({ ...base, photoScore: null })).toBe("identified");
    expect(computeReadiness({ ...base, missingAngles: ["Both soles"] })).toBe("identified");
  });

  it("is logged when identity or range falls short", () => {
    expect(computeReadiness({ ...base, identityConf: 0.84 })).toBe("logged");
    expect(computeReadiness({ ...base, valueHighCents: 16_001 })).toBe("logged");
    expect(computeReadiness({ ...base, valueLowCents: null })).toBe("logged");
  });

  it("accepts owner confirmation in place of confidence, and 1.6 times exactly", () => {
    expect(
      computeReadiness({ ...base, identityConf: 0.5, identityConfirmed: true, photoScore: 10 }),
    ).toBe("identified");
    expect(computeReadiness({ ...base, valueHighCents: 16_000, photoScore: 0 })).toBe("identified");
  });
});

describe("question ranking", () => {
  it("ranks by impact over effort, then age", () => {
    const at = new Date("2026-10-03T00:00:00Z");
    const later = new Date("2026-10-03T00:01:00Z");
    const tap = { kind: "yes_no" as const, impact: 0.4, createdAt: later };
    const photo = { kind: "photo" as const, impact: 0.9, createdAt: at };
    const older = { kind: "choice" as const, impact: 0.4, createdAt: at };
    expect(questionRank(tap)).toBeGreaterThan(questionRank(photo));
    expect([photo, tap, older].sort(compareQuestions)).toEqual([older, tap, photo]);
  });
});
