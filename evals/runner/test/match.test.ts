import { describe, expect, it } from "vitest";
import {
  categoryAgrees,
  dice,
  forbiddenHit,
  MATCH_THRESHOLD,
  matchItems,
  matchScore,
  rangesOverlap,
  tokens,
} from "../src/match.js";
import { label, predicted } from "./fixtures.js";

describe("tokens", () => {
  it("normalizes case, accents and punctuation, and drops stopwords and single letters", () => {
    expect([...tokens("The Pokémon Card, a 1st-Edition & 1 of X")]).toEqual([
      "pokemon",
      "card",
      "1st",
      "edition",
      "1",
    ]);
  });

  it("joins several fields and skips nulls", () => {
    expect(tokens("Pro Controller", null, "Nintendo")).toEqual(
      new Set(["pro", "controller", "nintendo"]),
    );
  });
});

describe("dice", () => {
  it("is 2 x shared over total, and 0 when either side is empty", () => {
    expect(dice(new Set(["a1", "b2"]), new Set(["a1", "c3"]))).toBe(0.5);
    expect(dice(new Set(), new Set(["a1"]))).toBe(0);
  });
});

describe("matchScore", () => {
  const jordan = label({
    title: "Air Jordan 1 Retro High OG",
    brand: "Nike",
    model: null,
    category: "sneakers",
  });

  it("scores the documented examples on either side of the threshold", () => {
    const close = predicted({ title: "Nike Air Jordan 1 High", brand: "Nike", model: null });
    const far = predicted({ title: "Nike Air Max 90", brand: "Nike", model: null });
    expect(matchScore(close, jordan)).toBeCloseTo(10 / 12);
    expect(matchScore(far, jordan)).toBeCloseTo(4 / 11);
    expect(matchScore(close, jordan)).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(matchScore(far, jordan)).toBeLessThan(MATCH_THRESHOLD);
  });

  it("uses the best of the title and aliases", () => {
    const l = label({
      title: "Nintendo Switch Pro Controller",
      aliases: ["Switch Pro Controller", "Pro Controller"],
      brand: "Nintendo",
      model: null,
    });
    const p = predicted({ title: "Pro Controller", brand: null, model: null });
    expect(matchScore(p, l)).toBeCloseTo(0.8);
  });

  it("vetoes 2 different model numbers even when the words agree", () => {
    const falcon = label({ title: "LEGO Star Wars Millennium Falcon", model: "75257" });
    const xwing = predicted({ title: "LEGO Star Wars Millennium Falcon", model: "75301" });
    expect(matchScore(xwing, falcon)).toBe(0);
  });

  it("lifts a pair whose model numbers agree, ignoring punctuation and prefixes", () => {
    const l = label({ title: "Typewriter", brand: null, model: "21327" });
    const p = predicted({ title: "Ideas set in box", brand: null, model: "LEGO 21327" });
    expect(matchScore(p, l)).toBe(0.75);
  });
});

describe("categoryAgrees", () => {
  it("is true when categories share a word", () => {
    expect(categoryAgrees("toys/lego", "Toys")).toBe(true);
    expect(categoryAgrees("sneakers", "video_games")).toBe(false);
  });
});

describe("matchItems", () => {
  it("assigns 1 to 1, best score first, and reports missed and unmatched", () => {
    const labels = [
      label({ title: "LEGO Typewriter", model: "21327" }),
      label({ title: "Nintendo Switch Pro Controller", brand: "Nintendo", model: null }),
      label({ title: "Harry Potter box set", brand: null, model: null, category: "books" }),
    ];
    const preds = [
      predicted({ title: "Switch Pro Controller", brand: "Nintendo", model: null }),
      predicted({ title: "LEGO Ideas Typewriter 21327" }),
      // A double count of the typewriter: only 1 can match.
      predicted({ title: "LEGO Typewriter" }),
      predicted({ title: "Desk lamp", brand: "IKEA", model: null, category: "home" }),
    ];
    const { matches, missed, unmatched } = matchItems(preds, labels);
    expect(matches.map((m) => [m.label, m.predicted])).toEqual([
      [0, 2],
      [1, 0],
    ]);
    expect(missed).toEqual([2]);
    expect(unmatched).toEqual([1, 3]);
  });

  it("breaks ties by category, then by index, so results never depend on order luck", () => {
    const labels = [
      label({ title: "Blue mug", brand: null, model: null, category: "kitchen" }),
      label({ title: "Blue mug", brand: null, model: null, category: "toys" }),
    ];
    const preds = [predicted({ title: "Blue mug", brand: null, model: null, category: "toys" })];
    expect(matchItems(preds, labels).matches).toEqual([{ predicted: 0, label: 1, score: 1 }]);
  });
});

describe("forbiddenHit", () => {
  it("needs every word of a phrase, so a water bottle is not a prescription bottle", () => {
    const pills = predicted({ title: "Prescription pill bottle", brand: null, model: null });
    const water = predicted({ title: "Hydro Flask water bottle", brand: null, model: null });
    const list = ["prescription bottle", "AC remote"];
    expect(forbiddenHit(pills, list)).toBe("prescription bottle");
    expect(forbiddenHit(water, list)).toBeNull();
  });
});

describe("rangesOverlap", () => {
  it("is inclusive at the edges", () => {
    expect(rangesOverlap({ low: 100, high: 200 }, { low: 200, high: 300 })).toBe(true);
    expect(rangesOverlap({ low: 100, high: 199 }, { low: 200, high: 300 })).toBe(false);
  });
});
