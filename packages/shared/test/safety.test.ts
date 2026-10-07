import { describe, expect, it } from "vitest";
import { cantTrade, prohibitedByWords } from "../src/safety.js";

describe("prohibitedByWords", () => {
  it("catches labels that can only mean a prohibited thing", () => {
    for (const [label, reason] of [
      ["Handgun in a case", "weapon"],
      ["Box of 9mm ammunition", "weapon"],
      ["Glock 19 pistol", "weapon"],
      ["Hunting rifle", "weapon"],
      ["Vape pen", "tobacco"],
      ["Pack of cigarettes", "tobacco"],
      ["Cuban cigars", "tobacco"],
      ["Cannabis gummies", "drugs"],
      ["Bottle of whiskey", "alcohol"],
      ["Unopened wine", "alcohol"],
      ["Vodka bottle", "alcohol"],
    ] as const) {
      expect(prohibitedByWords(label), label).toBe(reason);
    }
  });

  it("leaves toys, props, collectibles, games and brands alone", () => {
    for (const label of [
      "Nerf Elite 2.0 blaster",
      "Water pistol",
      "Toy rifle",
      "Airsoft pistol",
      "Rifle Paper Co. notebook",
      "Cigar box guitar",
      "Wine glasses, set of 4",
      "Whiskey bottle opener",
      "Gin Rummy card game",
      "Stuffed dog plush",
      "Baby stroller",
      "Dog bed",
      "Beer pong table",
    ]) {
      expect(prohibitedByWords(label), label).toBeNull();
    }
  });

  it("reads several fields together and says why in plain words", () => {
    expect(prohibitedByWords(null, "Vintage case", "with ammunition")).toBe("weapon");
    expect(cantTrade("live_animal")).toBe("Throw-In can't trade live animals.");
  });
});
