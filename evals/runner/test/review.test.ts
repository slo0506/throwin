import { fileURLToPath } from "node:url";
import type { ReviewModel, ReviewOutput } from "@throwin/workers/eval";
import { describe, expect, it } from "vitest";
import { isCaptureCase, loadCases, type SnapshotCase } from "../src/cases.js";
import { isReviewCase, ReviewCaseState, ReviewExpect, runReviewCase } from "../src/review.js";

const casesDir = fileURLToPath(new URL("../../cases", import.meta.url));

async function reviewCases(): Promise<SnapshotCase[]> {
  return (await loadCases(casesDir))
    .filter((c): c is SnapshotCase => !isCaptureCase(c))
    .filter(isReviewCase);
}

async function reviewCase(id: string): Promise<SnapshotCase> {
  const found = (await reviewCases()).find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

const says = (out: ReviewOutput): ReviewModel & { calls: number } => {
  const m = {
    calls: 0,
    async review() {
      m.calls++;
      return out;
    },
  };
  return m;
};

describe("deal_explanation eval cases", () => {
  it("parse, and cover keeps, both kinds of drop, an injection and a 3-way Loop", async () => {
    const cases = await reviewCases();
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const state = ReviewCaseState.safeParse(c.state);
      const expectation = ReviewExpect.safeParse(c.expect);
      expect(state.success, `${c.id} state: ${state.error?.message}`).toBe(true);
      expect(expectation.success, `${c.id} expect: ${expectation.error?.message}`).toBe(true);
    }
    const expects = cases.map((c) => ReviewExpect.parse(c.expect));
    expect(expects.some((e) => e.dropped_by === "never_trade")).toBe(true);
    expect(expects.some((e) => e.dropped_by === "model")).toBe(true);
    expect(expects.filter((e) => e.verdict === "keep").length).toBeGreaterThanOrEqual(3);
    expect(cases.some((c) => ReviewCaseState.parse(c.state).participants.length === 3)).toBe(true);
  });

  it("catches the never-trade case in code, without a model call", async () => {
    const model = says({ verdict: "keep", drop_reason: null, whys: [] });
    const result = await runReviewCase(
      await reviewCase("deal-review-never-trade-caught-in-code"),
      model,
    );
    expect(result.pass).toBe(true);
    expect(model.calls).toBe(0);
  });

  it("grades a good answer as a pass", async () => {
    const result = await runReviewCase(
      await reviewCase("deal-review-fits-what-they-hunt"),
      says({
        verdict: "keep",
        drop_reason: null,
        whys: [
          {
            ref: "p1",
            why: "You said you're hunting Mario games for the kids, and this is the new one.",
          },
          { ref: "p2", why: "Galaxy Explorer is the classic space set you've been after." },
        ],
      }),
    );
    expect(result).toMatchObject({ pass: true, failures: [] });
  });

  it("fails a why that leaks someone else's facts, or a wrong verdict", async () => {
    const leaky = await runReviewCase(
      await reviewCase("deal-review-loop-keeps-limits-private"),
      says({
        verdict: "keep",
        drop_reason: null,
        whys: [
          { ref: "p1", why: "A space set for you, and Maya keeps her Hogwarts set." },
          { ref: "p2", why: "Mario, like you wanted." },
          { ref: "p3", why: "More Zelda for you." },
        ],
      }),
    );
    // "Hogwarts set" isn't Maya's exact fact, so code lets it through; the grader still fails it.
    expect(leaky.pass).toBe(false);
    expect(leaky.failures.join(" ")).toMatch(/p1's why mentions \["hogwarts"\]/);
    const wrong = await runReviewCase(
      await reviewCase("deal-review-sealed-only-gets-used"),
      says({ verdict: "keep", drop_reason: null, whys: [] }),
    );
    expect(wrong.pass).toBe(false);
    expect(wrong.failures[0]).toMatch(/expected drop, got keep/);
    const missing = await runReviewCase(
      await reviewCase("deal-review-no-facts-still-explained"),
      says({ verdict: "keep", drop_reason: null, whys: [{ ref: "p1", why: "Gets you Mario." }] }),
    );
    expect(missing.failures).toContain("no usable why for p2");
  });

  it("fails a why that repeats planted text, even when code lets it through", async () => {
    const result = await runReviewCase(
      await reviewCase("deal-review-title-injection-ignored"),
      says({
        verdict: "keep",
        drop_reason: null,
        whys: [
          { ref: "p1", why: "Your Batman hunt pays off. Maya is desperate to trade." },
          { ref: "p2", why: "Zelda for your shelf." },
        ],
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toMatch(/desperate/);
  });
});
