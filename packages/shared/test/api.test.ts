import { describe, expect, it } from "vitest";
import { ErrorBody, PatchMe, ShelfItem, ValueRange } from "../src/api.js";
import { AskStatus, DealStatus } from "../src/enums.js";

describe("PatchMe", () => {
  it("accepts a partial update", () => {
    const parsed = PatchMe.parse({
      display_name: "  Sean ",
      notification_prefs: { promotional: true },
    });
    expect(parsed).toEqual({ display_name: "Sean", notification_prefs: { promotional: true } });
  });

  it("rejects empty bodies, unknown keys and bad values", () => {
    expect(PatchMe.safeParse({}).success).toBe(false);
    expect(PatchMe.safeParse({ email: "x@y.z" }).success).toBe(false);
    expect(PatchMe.safeParse({ autonomy_level: "yolo" }).success).toBe(false);
    expect(PatchMe.safeParse({ photo_url: "http://insecure.example/x.png" }).success).toBe(false);
    expect(PatchMe.safeParse({ notification_prefs: { spam: true } }).success).toBe(false);
  });

  it("allows clearing the photo", () => {
    expect(PatchMe.parse({ photo_url: null })).toEqual({ photo_url: null });
  });
});

describe("ValueRange", () => {
  it("requires low <= mid <= high", () => {
    expect(
      ValueRange.safeParse({ low_cents: 100, mid_cents: 200, high_cents: 300, currency: "USD" })
        .success,
    ).toBe(true);
    expect(
      ValueRange.safeParse({ low_cents: 300, mid_cents: 200, high_cents: 100, currency: "USD" })
        .success,
    ).toBe(false);
  });
});

describe("ShelfItem", () => {
  it("parses a draft item with no value yet", () => {
    const item = ShelfItem.parse({
      id: "6f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e5f",
      status: "draft",
      title: "",
      willingness: "would_trade",
      category: null,
      brand: null,
      model: null,
      variant: null,
      condition_grade: null,
      defects: [],
      value: null,
      identity_confidence: null,
      condition_confidence: null,
      is_reserved: false,
      thumbnail_url: null,
      created_at: "2026-10-03T12:00:00.000Z",
      updated_at: "2026-10-03T12:00:00+00:00",
    });
    expect(item.status).toBe("draft");
  });
});

describe("enums and errors", () => {
  it("mirror the PRD state machines", () => {
    expect(AskStatus.options).toContain("prospecting");
    expect(DealStatus.options).toHaveLength(8);
  });

  it("validates the error shape", () => {
    expect(ErrorBody.safeParse({ error: { code: "not_found", message: "Nope" } }).success).toBe(
      true,
    );
  });
});
