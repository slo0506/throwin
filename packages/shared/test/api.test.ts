import { describe, expect, it } from "vitest";
import {
  AnswerRequest,
  ErrorBody,
  ItemMediaRequest,
  ItemMediaUploadRequest,
  PatchMe,
  Question,
  ShelfItem,
  ValueRange,
} from "../src/api.js";
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
      follow_up: null,
      is_appraising: true,
      readiness: "logged",
      photo_score: null,
      photo_issues: [],
      missing_angles: [],
      studio_allowed: false,
      description: null,
      open_questions: 0,
      created_at: "2026-10-03T12:00:00.000Z",
      updated_at: "2026-10-03T12:00:00+00:00",
    });
    expect(item.status).toBe("draft");
    expect(item.is_appraising).toBe(true);
  });

  it("rejects unknown readiness and photo issue codes", () => {
    const base = ShelfItem.shape;
    expect(base.readiness.safeParse("ready").success).toBe(false);
    expect(base.photo_issues.safeParse(["too_small", "ugly"]).success).toBe(false);
    expect(base.photo_score.safeParse(101).success).toBe(false);
  });
});

describe("questions", () => {
  it("accepts an answer or a skip, never both or neither", () => {
    expect(AnswerRequest.safeParse({ answer: "Yes" }).success).toBe(true);
    expect(AnswerRequest.safeParse({ skip: true }).success).toBe(true);
    expect(AnswerRequest.safeParse({ answer: "Yes", skip: true }).success).toBe(false);
    expect(AnswerRequest.safeParse({ skip: false }).success).toBe(false);
    expect(AnswerRequest.safeParse({}).success).toBe(false);
    expect(AnswerRequest.safeParse({ answer: "x".repeat(201) }).success).toBe(false);
  });

  it("validates the question shape", () => {
    const q = {
      id: "6f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e5f",
      item_id: "6f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e50",
      item_title: "White high-top sneakers",
      thumbnail_url: null,
      kind: "yes_no",
      prompt: "Is this Nike?",
      options: ["Yes", "No", "Not sure"],
      created_at: "2026-10-03T12:00:00.000Z",
    };
    expect(Question.safeParse(q).success).toBe(true);
    expect(Question.safeParse({ ...q, kind: "essay" }).success).toBe(false);
  });
});

describe("follow-up photos", () => {
  it("caps uploads at 5 and rejects unknown keys", () => {
    expect(ItemMediaUploadRequest.safeParse({ count: 5 }).success).toBe(true);
    expect(ItemMediaUploadRequest.safeParse({ count: 6 }).success).toBe(false);
    expect(ItemMediaUploadRequest.safeParse({ count: 1, kind: "photo" }).success).toBe(false);
    expect(ItemMediaRequest.safeParse({ media: [] }).success).toBe(false);
    expect(ItemMediaRequest.safeParse({ media: [{ path: "a/items/b/c.jpg" }] }).success).toBe(true);
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
