import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isCaptureCase, loadCases, parseCase, unreviewedLabels } from "../src/cases.js";
import { capture, label } from "./fixtures.js";

describe("loadCases", () => {
  it("loads the repo's cases directory", async () => {
    const dir = fileURLToPath(new URL("../../cases", import.meta.url));
    await expect(loadCases(dir)).resolves.toBeInstanceOf(Array);
  });

  it("keeps the version 1 appraisal cases valid", async () => {
    const dir = fileURLToPath(new URL("../../cases/appraisal", import.meta.url));
    const cases = await loadCases(dir);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.some((c) => !isCaptureCase(c) && "photos" in c.state)).toBe(true);
  });

  it("validates case files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-"));
    const good = {
      id: "grounding-price-from-tool",
      suite: "grounding",
      description: "Prices in the reply come from get_item",
      state: {},
      conversation: [],
      message: "How much is my Batmobile worth?",
      expect: { cites_tool: "get_item" },
    };
    await writeFile(join(dir, "good.json"), JSON.stringify(good));
    await expect(loadCases(dir)).resolves.toHaveLength(1);

    await writeFile(join(dir, "bad.json"), JSON.stringify({ ...good, suite: "vibes" }));
    await expect(loadCases(dir)).rejects.toThrow(/bad\.json/);
  });

  it("loads both shapes side by side and rejects duplicate ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-"));
    await writeFile(join(dir, "capture.json"), JSON.stringify(capture()));
    await writeFile(
      join(dir, "snapshot.json"),
      JSON.stringify({
        id: "appraisal-old",
        suite: "appraisal",
        description: "Old shape",
        state: { photos: [{ source: "wikimedia-commons-search", query: "LEGO set box" }] },
        conversation: [],
        message: "",
        expect: { value_is_range: true },
      }),
    );
    const cases = await loadCases(dir);
    expect(cases.map(isCaptureCase).sort()).toEqual([false, true]);

    await writeFile(join(dir, "twin.json"), JSON.stringify(capture()));
    await expect(loadCases(dir)).rejects.toThrow(/duplicate case id/);
  });
});

describe("capture case schema", () => {
  it("fills defaults for aliases, forbidden and should_ask_for_photo", () => {
    const { aliases: _a, should_ask_for_photo: _s, ...bare } = label();
    const { forbidden: _f, ...rest } = capture({ items: [] });
    const parsed = parseCase({ ...rest, items: [bare] });
    expect(parsed.success).toBe(true);
    if (parsed.success && isCaptureCase(parsed.data)) {
      expect(parsed.data.forbidden).toEqual([]);
      expect(parsed.data.items[0]).toMatchObject({ aliases: [], should_ask_for_photo: false });
    }
  });

  it.each([
    ["an inverted range", { items: [label({ value_cents_low: 500, value_cents_high: 100 })] }],
    ["fractional cents", { items: [label({ value_cents_low: 10.5 })] }],
    ["an unknown grade", { items: [{ ...label(), condition_grade: "E" }] }],
    ["no media", { media: [] }],
    ["another suite", { suite: "grounding" }],
    ["an unknown version", { version: 3 }],
    ["an unknown field", { extra: true }],
    ["a label without reviewed", { items: [{ ...label(), reviewed: undefined }] }],
  ])("rejects %s", (_, overrides) => {
    expect(parseCase({ ...capture(), ...overrides }).success).toBe(false);
  });

  it("lists unreviewed labels", () => {
    const c = capture({ items: [label(), label({ title: "Draft thing", reviewed: false })] });
    expect(unreviewedLabels([c])).toEqual(["appraisal-test-shelf: Draft thing"]);
  });
});
