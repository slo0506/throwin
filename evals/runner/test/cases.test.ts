import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases } from "../src/cases.js";

describe("loadCases", () => {
  it("loads the repo's cases directory", async () => {
    const dir = fileURLToPath(new URL("../../cases", import.meta.url));
    await expect(loadCases(dir)).resolves.toBeInstanceOf(Array);
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
});
