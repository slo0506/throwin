import { describe, expect, it } from "vitest";
import {
  AskCreate,
  AskPatch,
  AskStatus,
  AskTarget,
  askStatusLine,
  TASTE_FACT_KEY,
  TasteFact,
} from "../src/index.js";

describe("AskTarget", () => {
  it("fills defaults so the wire shape is always complete", () => {
    expect(AskTarget.parse({ kind: "category", name: " Switch games " })).toEqual({
      kind: "category",
      name: "Switch games",
      brand: null,
      model: null,
      category: null,
      constraints: [],
      anchor: null,
    });
  });

  it("requires the anchor to be a range", () => {
    const base = { kind: "exact", name: "Tumbler" };
    expect(
      AskTarget.safeParse({ ...base, anchor: { used_low_cents: 100, used_high_cents: 200 } })
        .success,
    ).toBe(true);
    expect(
      AskTarget.safeParse({ ...base, anchor: { used_low_cents: 300, used_high_cents: 200 } })
        .success,
    ).toBe(false);
    expect(AskTarget.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("AskCreate and AskPatch", () => {
  it("accepts the contract's create body", () => {
    expect(
      AskCreate.parse({ raw_text: "the big Lego Batmobile", cash_ceiling_cents: 2000 }),
    ).toEqual({ raw_text: "the big Lego Batmobile", cash_ceiling_cents: 2000 });
  });

  it("dedupes and lowercases offer Item IDs", () => {
    const id = "6f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e5f";
    expect(AskPatch.parse({ offer_item_ids: [id, id.toUpperCase()] })).toEqual({
      offer_item_ids: [id],
    });
  });

  it("only allows cancelled as a status and needs at least 1 field", () => {
    expect(AskPatch.safeParse({ status: "cancelled" }).success).toBe(true);
    expect(AskPatch.safeParse({ status: "prospecting" }).success).toBe(false);
    expect(AskPatch.safeParse({}).success).toBe(false);
    expect(AskPatch.safeParse({ cash_ceiling_cents: 100001 }).success).toBe(false);
  });
});

describe("askStatusLine", () => {
  it("has plain words for every status, without em dashes", () => {
    for (const status of AskStatus.options) {
      for (const count of [0, 2]) {
        const line = askStatusLine(status, count);
        expect(line.length).toBeGreaterThan(0);
        expect(line).not.toMatch(/—/);
      }
    }
    expect(askStatusLine("offering", 0)).toBe("Waiting for what you'd offer");
    expect(askStatusLine("prospecting", 2)).toBe("Looking through your Circles");
  });
});

describe("TasteFact", () => {
  it("takes snake_case keys only", () => {
    expect(TASTE_FACT_KEY.test("never_trade")).toBe(true);
    expect(TASTE_FACT_KEY.test("Never_trade")).toBe(false);
    expect(TASTE_FACT_KEY.test("never-trade")).toBe(false);
    expect(
      TasteFact.safeParse({
        id: "6f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e5f",
        key: "never_trade",
        value: "Millennium Falcon",
        category: "limits",
        source: "Intake chat",
        always_on: true,
        created_at: "2026-10-03T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
