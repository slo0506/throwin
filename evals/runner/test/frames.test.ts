import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  expandMedia,
  hasFfmpeg,
  keepSharp,
  laplacianVariance,
  loadCaptureFrames,
  MAX_FRAMES,
  sharpness,
} from "../src/frames.js";

const frames = (...values: number[]) => values.map((sharpness, i) => ({ i, sharpness }));

describe("laplacianVariance", () => {
  it("is 0 for a flat image and positive for edges", () => {
    expect(laplacianVariance(new Uint8Array(25).fill(128), 5, 5)).toBe(0);
    const checker = Uint8Array.from({ length: 25 }, (_, i) =>
      ((i % 5) + Math.floor(i / 5)) % 2 ? 255 : 0,
    );
    expect(laplacianVariance(checker, 5, 5)).toBeGreaterThan(0);
  });

  it("is 0 when there are no interior pixels", () => {
    expect(laplacianVariance(new Uint8Array(4), 2, 2)).toBe(0);
  });
});

describe("sharpness", () => {
  it("rates a crisp pattern above a blurred copy of it", async () => {
    const stripes = Buffer.alloc(320 * 240 * 3);
    for (let i = 0; i < 320 * 240; i++)
      stripes.fill(Math.floor(i / 4) % 2 ? 255 : 0, i * 3, i * 3 + 3);
    const crisp = await sharp(stripes, { raw: { width: 320, height: 240, channels: 3 } })
      .png()
      .toBuffer();
    const blurred = await sharp(crisp).blur(4).png().toBuffer();
    expect(await sharpness(crisp)).toBeGreaterThan((await sharpness(blurred)) * 2);
  });
});

describe("keepSharp", () => {
  it("drops frames under 0.4x the median, keeping order", () => {
    // Median of [10, 100, 100, 100, 3, 50] sorted is 100 (index 3), so the bar is 40.
    expect(keepSharp(frames(10, 100, 100, 100, 3, 50)).map((f) => f.i)).toEqual([1, 2, 3, 5]);
  });

  it("keeps everything at 3 frames or fewer", () => {
    expect(keepSharp(frames(1, 100, 100))).toHaveLength(3);
  });

  it("thins evenly to the cap", () => {
    const many = frames(...Array.from({ length: 60 }, () => 50));
    const kept = keepSharp(many);
    expect(kept).toHaveLength(MAX_FRAMES);
    expect(kept.map((f) => f.i)).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
  });
});

async function photo(path: string, color: string) {
  await writeFile(
    path,
    await sharp({ create: { width: 1800, height: 1200, channels: 3, background: color } })
      .jpeg()
      .toBuffer(),
  );
}

const ffmpeg = await hasFfmpeg();

describe("loading media", () => {
  it("expands folders to sorted media files and rejects what isn't media", async () => {
    const root = await mkdtemp(join(tmpdir(), "evals-media-"));
    await mkdir(join(root, "shelf"));
    await photo(join(root, "shelf", "b.jpg"), "#fff");
    await photo(join(root, "shelf", "a.jpg"), "#000");
    await writeFile(join(root, "shelf", "notes.txt"), "not media");
    expect(await expandMedia(root, ["shelf"])).toEqual([
      join("shelf", "a.jpg"),
      join("shelf", "b.jpg"),
    ]);
    await expect(expandMedia(root, ["shelf/notes.txt"])).rejects.toThrow(/not an image/);
    await expect(expandMedia(root, ["missing"])).rejects.toThrow(/not found/);
  });

  it("downsizes photos to 1600 px like the iOS client and caps a capture at 30", async () => {
    const root = await mkdtemp(join(tmpdir(), "evals-media-"));
    await mkdir(join(root, "big"));
    for (let i = 0; i < 32; i++)
      await photo(join(root, "big", `${String(i).padStart(2, "0")}.jpg`), "#888");
    const loaded = await loadCaptureFrames(root, ["big"]);
    expect(loaded).toHaveLength(30);
    const meta = await sharp(loaded[0]?.jpeg).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1600);
    expect(loaded[29]?.source).toBe(join("big", "29.jpg"));
  });

  it.skipIf(!ffmpeg)("samples a video at 1 frame a second", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const root = await mkdtemp(join(tmpdir(), "evals-media-"));
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=4:size=320x240:rate=10",
      "-pix_fmt",
      "yuv420p",
      join(root, "pan.mp4"),
    ]);
    const loaded = await loadCaptureFrames(root, ["pan.mp4"]);
    expect(loaded.length).toBeGreaterThanOrEqual(3);
    expect(loaded.length).toBeLessThanOrEqual(4);
    expect(loaded[0]?.source).toBe("pan.mp4#0");
  });
});
