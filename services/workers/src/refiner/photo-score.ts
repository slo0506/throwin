import { MIN_LONG_EDGE_PX, type PhotoIssue, SMALL_PHOTO_CAP } from "@throwin/shared";
import sharp from "sharp";
import { type PreparedImage, sharpness } from "../appraiser/images.js";
import type { PhotoJudgment } from "./schemas.js";

/** The measurable parts of a photo, computed in code (PRD "Photo quality and Studio"). */
export interface PhotoMetrics {
  /** Pixels on the long edge of the Item's crop. */
  longEdge: number;
  /** Variance of the Laplacian at up to 512 px, the same measure the iOS app uses. */
  sharpness: number;
  /** Mean brightness, 0 to 255. */
  mean: number;
  /** Share of pixels crushed to black (5 or less) and blown to white (250 or more). */
  darkClip: number;
  brightClip: number;
}

export interface PhotoScoreConfig {
  /** Laplacian variance at or below which a photo counts as fully blurry. */
  sharpnessLow: number;
  /** Laplacian variance at or above which a photo counts as fully sharp. */
  sharpnessHigh: number;
}

export const DEFAULT_PHOTO_SCORE: PhotoScoreConfig = { sharpnessLow: 20, sharpnessHigh: 200 };

/**
 * Points per factor, 100 in all. Resolution and sharpness weigh most because no backdrop
 * or framing fixes a tiny or blurry photo; the 3 judgment parts share the rest.
 */
export const WEIGHTS = {
  resolution: 20,
  sharpness: 20,
  exposure: 15,
  framing: 15,
  background: 15,
  coverage: 15,
} as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export async function measure(image: PreparedImage): Promise<PhotoMetrics> {
  const { data, info } = await sharp(image.jpeg)
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i * info.channels] as number;
    sum += v;
    if (v <= 5) dark++;
    else if (v >= 250) bright++;
  }
  return {
    longEdge: Math.max(image.width, image.height),
    sharpness: await sharpness(image),
    mean: n > 0 ? sum / n : 0,
    darkClip: n > 0 ? dark / n : 0,
    brightClip: n > 0 ? bright / n : 0,
  };
}

export interface PhotoScore {
  score: number;
  issues: PhotoIssue[];
  /** Showcase angles for the category not seen in any of the Item's photos. */
  missingAngles: string[];
  /** Each factor from 0 to 1, for logs and evals. */
  parts: Record<keyof typeof WEIGHTS, number>;
}

/**
 * Combines code metrics and the model's judgment into 0 to 100. A long edge under 600 px
 * caps the score at 40, below the Studio bar, since lifting a tiny crop only makes a tiny
 * sticker.
 */
export function combine(
  m: PhotoMetrics,
  judgment: PhotoJudgment,
  angles: readonly string[],
  config: PhotoScoreConfig = DEFAULT_PHOTO_SCORE,
): PhotoScore {
  const resolution = clamp01((m.longEdge - 300) / (1000 - 300));
  const sharp = clamp01(
    (m.sharpness - config.sharpnessLow) / (config.sharpnessHigh - config.sharpnessLow),
  );
  // Exposure: brightness far from mid grey, and clipped shadows or highlights.
  const offMid = clamp01((Math.abs(m.mean - 128) - 50) / 60);
  const exposure = clamp01(1 - offMid - 2 * m.darkClip - 2 * m.brightClip);
  const framing = !judgment.item_visible
    ? 0
    : judgment.whole_item_in_frame
      ? clamp01(0.4 + judgment.fill)
      : clamp01(0.5 * judgment.fill);
  const background = { clean: 1, some_clutter: 0.6, cluttered: 0.2 }[judgment.background];
  const seen = new Set(judgment.angles_present.map((a) => a.trim().toLowerCase()));
  const missingAngles = angles.filter((a) => !seen.has(a.toLowerCase()));
  const coverage = angles.length > 0 ? (angles.length - missingAngles.length) / angles.length : 1;

  const parts = { resolution, sharpness: sharp, exposure, framing, background, coverage };
  let score = Math.round(
    (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
      (total, k) => total + WEIGHTS[k] * parts[k],
      0,
    ),
  );
  if (m.longEdge < MIN_LONG_EDGE_PX) score = Math.min(score, SMALL_PHOTO_CAP);

  const issues: PhotoIssue[] = [];
  if (m.longEdge < MIN_LONG_EDGE_PX) issues.push("too_small");
  if (sharp < 0.4) issues.push("blurry");
  if (m.mean < 70 || m.darkClip > 0.2) issues.push("dark");
  if (judgment.item_visible && !judgment.whole_item_in_frame) issues.push("cut_off");
  if (judgment.background === "cluttered") issues.push("cluttered_background");
  if (missingAngles.length > 0) issues.push("missing_angles");
  return { score: Math.max(0, Math.min(100, score)), issues, missingAngles, parts };
}
