import { describe, expect, it } from "vitest";
import { Budget, DEFAULT_MAX_CENTS, parseMaxCents } from "../src/budget.js";

describe("Budget", () => {
  it("defaults to $2 and stops once spent reaches the cap", () => {
    const budget = parseMaxCents(undefined);
    expect(budget.maxCents).toBe(DEFAULT_MAX_CENTS);
    budget.add(150);
    expect(budget.exhausted).toBe(false);
    budget.add(50);
    expect(budget.exhausted).toBe(true);
    expect(budget.message).toContain("200 cent budget");
  });

  it("refuses a cap that isn't a positive number", () => {
    expect(() => new Budget(0)).toThrow();
    expect(() => parseMaxCents("lots")).toThrow();
  });
});
