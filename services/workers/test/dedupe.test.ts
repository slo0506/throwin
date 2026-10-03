import { describe, expect, it } from "vitest";
import { VoyageEmbedder } from "../src/appraiser/embeddings.js";
import { containment, mergeNested } from "../src/appraiser/pipeline.js";
import type { DetectedObject } from "../src/appraiser/schemas.js";

const obj = (
  label: string,
  ...apps: [number, [number, number, number, number]][]
): DetectedObject => ({
  label,
  category: "toys",
  appearances: apps.map(([frame, box]) => ({ frame, box })),
});

describe("mergeNested", () => {
  it("folds parts inside a whole into 1 object", () => {
    const set = obj("LEGO moon buggy set", [0, [0.1, 0.1, 0.9, 0.9]]);
    const fig = obj("minifigure", [0, [0.2, 0.2, 0.3, 0.35]]);
    const sheet = obj("instruction sheet", [0, [0.5, 0.1, 0.88, 0.6]], [1, [0.1, 0.1, 0.5, 0.5]]);
    const out = mergeNested([fig, set, sheet]);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("LEGO moon buggy set");
    // Frame 1 only saw the sheet, but it still shows the set, so it is kept.
    expect(out[0]?.appearances.map((a) => a.frame).sort()).toEqual([0, 1]);
  });

  it("never folds items into a background-sized box", () => {
    const shelf = obj("shelf", [0, [0, 0, 1, 1]]);
    const game = obj("game", [0, [0.2, 0.2, 0.3, 0.3]]);
    expect(mergeNested([shelf, game])).toHaveLength(2);
  });

  it("keeps side by side objects apart", () => {
    const left = obj("sneaker", [0, [0.0, 0.2, 0.45, 0.8]]);
    const right = obj("controller", [0, [0.55, 0.2, 1.0, 0.8]]);
    expect(mergeNested([left, right])).toHaveLength(2);
  });

  it("keeps objects that only touch, and nested boxes in different frames", () => {
    const a = obj("book", [0, [0.0, 0.0, 0.5, 0.5]]);
    const b = obj("card", [0, [0.4, 0.4, 0.6, 0.6]], [1, [0.1, 0.1, 0.2, 0.2]]);
    const c = obj("figure", [1, [0.05, 0.05, 0.25, 0.25]]);
    expect(containment([0, 0, 0.5, 0.5], [0.4, 0.4, 0.6, 0.6])).toBeCloseTo(0.25);
    // c contains b in frame 1, so b folds into c; a stays separate.
    expect(
      mergeNested([a, b, c])
        .map((o) => o.label)
        .sort(),
    ).toEqual(["book", "figure"]);
  });
});

describe("VoyageEmbedder", () => {
  const ok = () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });

  it("retries rate limits, then succeeds", async () => {
    const statuses = [429, 503];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const status = statuses.shift();
      return status ? new Response("slow down", { status }) : ok();
    }) as typeof fetch;
    const embedder = new VoyageEmbedder("k", fetchImpl, [0, 0, 0]);
    expect(await embedder.embed("t", Buffer.from("x"))).toEqual([0.1, 0.2]);
    expect(calls).toBe(3);
  });

  it("does not retry a bad request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;
    const embedder = new VoyageEmbedder("k", fetchImpl, [0, 0, 0]);
    await expect(embedder.embed("t", Buffer.from("x"))).rejects.toThrow("voyage 400");
    expect(calls).toBe(1);
  });
});
