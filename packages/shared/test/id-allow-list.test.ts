import { describe, expect, it } from "vitest";
import { IdAllowList, UnknownIdError } from "../src/id-allow-list.js";

describe("IdAllowList", () => {
  it("remembers single IDs and iterables", () => {
    const list = new IdAllowList();
    list.remember("a");
    list.remember(["b", "c"]);
    expect(list.has("a")).toBe(true);
    expect(list.has("c")).toBe(true);
    expect(list.has("d")).toBe(false);
    expect(list.size).toBe(3);
  });

  it("assert throws UnknownIdError for IDs the session never saw", () => {
    const list = new IdAllowList();
    list.remember(["item-1"]);
    expect(() => list.assert("item-1")).not.toThrow();
    expect(() => list.assert("item-2")).toThrow(UnknownIdError);
  });

  it("keeps sessions isolated", () => {
    const a = new IdAllowList();
    const b = new IdAllowList();
    a.remember("deal-1");
    expect(b.has("deal-1")).toBe(false);
  });
});
