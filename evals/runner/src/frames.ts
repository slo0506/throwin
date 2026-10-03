import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

/**
 * Mirrors the iOS client's FrameTools (apps/ios/ThrowIn/Features/Capture/FrameTools.swift):
 * frames are downsized to 1600 px, videos are sampled at 1 frame a second from half a
 * second in, blurry video frames are dropped, and a capture keeps at most 30 frames.
 */
export const MAX_EDGE = 1600;
export const MAX_FRAMES = 30;
/** Video frames under this share of the video's median sharpness are dropped. */
export const BLUR_SHARE = 0.4;
const SHARPNESS_WIDTH = 160;

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v"]);

export interface Frame {
  jpeg: Buffer;
  /** Variance of the Laplacian on a 160 px wide grayscale copy. Higher is sharper. */
  sharpness: number;
  /** The file it came from, relative to the media root, plus a frame index for video. */
  source: string;
}

/** Variance of a 4-neighbor Laplacian over a grayscale bitmap, interior pixels only. */
export function laplacianVariance(pixels: Uint8Array, width: number, height: number) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        4 * (pixels[i] as number) -
        (pixels[i - 1] as number) -
        (pixels[i + 1] as number) -
        (pixels[i - width] as number) -
        (pixels[i + width] as number);
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

export async function sharpness(image: Buffer) {
  const { data, info } = await sharp(image)
    .rotate()
    .resize({ width: SHARPNESS_WIDTH })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Grayscale output can keep extra channels in some inputs; take the first.
  const pixels =
    info.channels === 1
      ? new Uint8Array(data)
      : Uint8Array.from(
          { length: info.width * info.height },
          (_, i) => data[i * info.channels] ?? 0,
        );
  return laplacianVariance(pixels, info.width, info.height);
}

/**
 * Drops frames far blurrier than the video's typical frame (motion blur while panning),
 * then thins evenly to `max`, keeping order. Only applies the blur filter above 3 frames.
 */
export function keepSharp<T extends { sharpness: number }>(frames: T[], max = MAX_FRAMES): T[] {
  let kept = frames;
  if (frames.length > 3) {
    const sorted = frames.map((f) => f.sharpness).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    kept = frames.filter((f) => f.sharpness >= median * BLUR_SHARE);
  }
  if (kept.length <= max) return kept;
  const step = kept.length / max;
  return Array.from({ length: max }, (_, i) => kept[Math.floor(i * step)] as T);
}

async function toFrame(input: Buffer, source: string): Promise<Frame> {
  const jpeg = await sharp(input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { jpeg, sharpness: await sharpness(jpeg), source };
}

let ffmpegChecked: boolean | null = null;
export async function hasFfmpeg() {
  if (ffmpegChecked === null) {
    ffmpegChecked = await run("ffmpeg", ["-version"]).then(
      () => true,
      () => false,
    );
  }
  return ffmpegChecked;
}

async function videoDuration(path: string) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

/** 1 frame a second at 0.5 s, 1.5 s, and so on, up to 60 before the blur filter (as iOS). */
export async function videoFrames(path: string, source: string): Promise<Frame[]> {
  if (!(await hasFfmpeg())) {
    throw new Error(`${source}: videos need ffmpeg and ffprobe on PATH`);
  }
  const seconds = await videoDuration(path);
  if (seconds <= 0) return [];
  const count = Math.min(MAX_FRAMES * 2, Math.max(1, Math.floor(seconds)));
  const dir = await mkdtemp(join(tmpdir(), "throwin-frames-"));
  try {
    const frames: Frame[] = [];
    for (let i = 0; i < count; i++) {
      const at = Math.min(i + 0.5, Math.max(0, seconds - 0.1));
      const out = join(dir, `${i}.png`);
      try {
        await run("ffmpeg", [
          "-v",
          "error",
          "-ss",
          at.toFixed(3),
          "-i",
          path,
          "-frames:v",
          "1",
          "-y",
          out,
        ]);
        frames.push(await toFrame(await readFile(out), `${source}#${i}`));
      } catch {
        // A frame that fails to decode is skipped, as on iOS.
      }
    }
    return keepSharp(frames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isMedia = (name: string) => {
  const ext = extname(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
};

/** Expands folders to the images and videos inside, sorted by name. Paths stay relative. */
export async function expandMedia(root: string, entries: string[]) {
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(root, entry);
    const info = await stat(full).catch(() => null);
    if (!info) throw new Error(`media not found: ${full}`);
    if (info.isDirectory()) {
      const names = (await readdir(full)).filter(isMedia).sort();
      if (names.length === 0) throw new Error(`no images or videos in ${full}`);
      files.push(...names.map((n) => join(entry, n)));
    } else {
      if (!isMedia(entry)) throw new Error(`not an image or video: ${full}`);
      files.push(entry);
    }
  }
  return files;
}

/** Loads a capture's media the way the iOS client would upload it. */
export async function loadCaptureFrames(root: string, entries: string[]): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const file of await expandMedia(root, entries)) {
    const full = resolve(root, file);
    if (VIDEO_EXTENSIONS.has(extname(file).toLowerCase())) {
      frames.push(...(await videoFrames(full, file)));
    } else {
      frames.push(await toFrame(await readFile(full), file));
    }
  }
  // The capture tray holds at most 30 frames; extra ones never upload.
  return frames.slice(0, MAX_FRAMES);
}
