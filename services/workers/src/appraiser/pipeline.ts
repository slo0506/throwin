import type { Logger } from "../log.js";
import type { ModelRun, Vision } from "./claude.js";
import type { Embedder } from "./embeddings.js";
import { boxArea, crop, type PreparedImage, prepare } from "./images.js";
import type { DetectedObject, Identification, ValueEstimate } from "./schemas.js";

/** Items need both confidences at or above this to go straight onto the Shelf (PRD). */
export const CONFIDENCE_THRESHOLD = 0.7;
const MAX_ITEMS = 12;
const PARALLEL_ITEMS = 4;

export interface CaptureMedia {
  path: string;
  position: number;
  sharpness: number | null;
}

export interface NewItem {
  userId: string;
  captureId: string;
  status: "on_shelf" | "needs_photos";
  title: string;
  identification: Identification;
  value: ValueEstimate | null;
  cropPath: string;
  crop: PreparedImage;
  comps: { research: string; basis: string[] };
}

export interface Progress {
  stage: "detecting" | "identifying" | "pricing" | "done" | "failed";
  detail: string;
  found?: number;
}

/** Everything the Appraiser reads and writes. Supabase in production, memory in tests. */
export interface AppraiserStore {
  loadCapture(captureId: string): Promise<{ userId: string; media: CaptureMedia[] } | null>;
  /** Removes Items a previous, failed attempt at this capture saved, so a retry can't duplicate. */
  clearCaptureItems(captureId: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  upload(path: string, jpeg: Buffer): Promise<void>;
  setProgress(captureId: string, progress: Progress): Promise<void>;
  insertItem(item: NewItem): Promise<string>;
  saveEmbedding(itemId: string, model: string, vector: number[]): Promise<void>;
  finishCapture(captureId: string, itemCount: number, progress: Progress): Promise<void>;
  failCapture(captureId: string, message: string): Promise<void>;
  recordRun(userId: string, run: ModelRun): Promise<void>;
}

export interface AppraiserDeps {
  store: AppraiserStore;
  vision: Vision;
  embedder: Embedder;
  logger: Logger;
}

/** Runs async work over items with a concurrency limit, keeping input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Picks the appearance to crop from: the largest box, tie-broken by frame sharpness. */
export function bestAppearances(object: DetectedObject, media: CaptureMedia[], count = 2) {
  const sharpness = (frame: number) => media[frame]?.sharpness ?? 0;
  return [...object.appearances]
    .filter((a) => a.frame < media.length && boxArea(a.box) > 0.0005)
    .sort((a, b) => boxArea(b.box) - boxArea(a.box) || sharpness(b.frame) - sharpness(a.frame))
    .slice(0, count);
}

type Box = [number, number, number, number];

/** Share of the smaller box covered by the larger one (1 means fully inside). */
export function containment(a: Box, b: Box) {
  const inter = boxArea([
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ]);
  const smaller = Math.min(boxArea(a), boxArea(b));
  return smaller > 0 ? inter / smaller : 0;
}

/** Above this, a box mostly inside another in the same frame is treated as part of it. */
export const CONTAINMENT_MERGE = 0.8;
/** A box this big is usually the shelf or table, not a thing that owns what sits on it. */
const BACKGROUND_AREA = 0.9;

/**
 * Folds parts into wholes: a minifigure or instruction sheet boxed inside its LEGO set, a
 * shoe inside the pair. Detectors sometimes report the pieces as well as the whole; trading
 * them as separate Items would be wrong. Keeps the larger object and its label.
 */
export function mergeNested(objects: DetectedObject[]): DetectedObject[] {
  const sized = objects
    .map((o) => ({ o, area: Math.max(0, ...o.appearances.map((a) => boxArea(a.box))) }))
    .sort((a, b) => b.area - a.area);
  const kept: DetectedObject[] = [];
  for (const { o } of sized) {
    const parent = kept.find((k) =>
      o.appearances.some((a) =>
        k.appearances.some(
          (ka) =>
            ka.frame === a.frame &&
            boxArea(ka.box) < BACKGROUND_AREA &&
            containment(ka.box, a.box) >= CONTAINMENT_MERGE,
        ),
      ),
    );
    if (!parent) {
      kept.push({ ...o, appearances: [...o.appearances] });
      continue;
    }
    // Frames where only the part was seen still show the whole; keep them for cropping.
    for (const a of o.appearances) {
      if (!parent.appearances.some((pa) => pa.frame === a.frame)) parent.appearances.push(a);
    }
  }
  return kept;
}

interface Candidate {
  index: number;
  object: DetectedObject;
  crops: PreparedImage[];
  identification: Identification;
}

const words = (title: string) =>
  new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1),
  );

/** Share of title words 2 readings have in common (Jaccard). */
export function titleOverlap(a: string, b: string) {
  const [wa, wb] = [words(a), words(b)];
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = wa.size + wb.size - shared;
  return union > 0 ? shared / union : 0;
}

/** Cheap filter before asking the model: same model number, or similar titles. */
export function looksAlike(a: Identification, b: Identification) {
  const norm = (v: string | null) => v?.trim().toLowerCase() || null;
  const modelA = norm(a.model);
  if (modelA && modelA === norm(b.model)) return true;
  const brandA = norm(a.brand);
  const sameBrand = brandA !== null && brandA === norm(b.brand);
  return titleOverlap(a.title, b.title) >= (sameBrand ? 0.4 : 0.6);
}

const MAX_SAME_ITEM_CHECKS = 8;

/**
 * Groups candidates the model says are 1 thing to trade and keeps the most confident
 * reading of each group. Only look-alikes seen in the same frame are checked, so 2 copies
 * on different shelves never cost a call. A failed check keeps both (never lose an Item).
 */
async function consolidate(
  candidates: Candidate[],
  frames: PreparedImage[],
  vision: Vision,
  logger: Logger,
): Promise<Candidate[]> {
  const parent = candidates.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : root(parent[i] as number));
  let checks = 0;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const [a, b] = [candidates[i] as Candidate, candidates[j] as Candidate];
      if (root(i) === root(j) || !looksAlike(a.identification, b.identification)) continue;
      const shared = a.object.appearances.find((pa) =>
        b.object.appearances.some((pb) => pb.frame === pa.frame),
      );
      if (!shared || checks >= MAX_SAME_ITEM_CHECKS) continue;
      checks++;
      try {
        const same = await vision.sameItem(
          frames[shared.frame] as PreparedImage,
          { crop: a.crops[0] as PreparedImage, title: a.identification.title },
          { crop: b.crops[0] as PreparedImage, title: b.identification.title },
        );
        if (same) parent[root(j)] = root(i);
      } catch (err) {
        logger.warn("appraiser_same_item_failed", { error: String(err) });
      }
    }
  }

  const best = new Map<number, Candidate>();
  candidates.forEach((c, i) => {
    const r = root(i);
    const current = best.get(r);
    if (
      !current ||
      c.identification.identity_confidence > current.identification.identity_confidence
    ) {
      best.set(r, c);
    }
  });
  const kept = [...best.values()].sort((a, b) => a.index - b.index);
  if (kept.length < candidates.length) {
    logger.info("appraiser_consolidated", {
      before: candidates.length,
      after: kept.length,
      checks,
    });
  }
  return kept;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Capture to Items: prepare frames, detect objects across frames (deduplicated by the
 * detector), crop each from its best frames, identify and grade, price with comps, embed,
 * and save. Low confidence lands in needs_photos with a specific follow-up request.
 */
export async function appraiseCapture(captureId: string, deps: AppraiserDeps): Promise<number> {
  const { store, vision, embedder, logger } = deps;
  const capture = await store.loadCapture(captureId);
  if (!capture) throw new Error(`capture ${captureId} not found`);
  const { userId } = capture;
  const media = [...capture.media].sort((a, b) => a.position - b.position);
  if (media.length === 0) throw new Error("capture has no media");
  await store.clearCaptureItems(captureId);

  await store.setProgress(captureId, { stage: "detecting", detail: "Looking at your photos" });
  const frames = await Promise.all(media.map(async (m) => prepare(await store.download(m.path))));

  const detection = await vision.detect(frames);
  const objects = mergeNested(detection.objects)
    .map((o) => ({ object: o, best: bestAppearances(o, media) }))
    .filter((o) => o.best.length > 0)
    .slice(0, MAX_ITEMS);
  logger.info("appraiser_detected", {
    capture_id: captureId,
    detected: detection.objects.length,
    objects: objects.length,
  });

  if (objects.length === 0) {
    await store.finishCapture(captureId, 0, {
      stage: "done",
      detail: "Didn't spot anything to trade. Try closer, with better light.",
      found: 0,
    });
    return 0;
  }

  await store.setProgress(captureId, {
    stage: "identifying",
    detail: `Found ${plural(objects.length, "item")}. Reading the details`,
    found: objects.length,
  });

  // 1. Identify and grade every object.
  const identified = await mapLimit(objects, PARALLEL_ITEMS, async ({ object, best }, index) => {
    try {
      const crops = await Promise.all(
        best.map((a) => crop(frames[a.frame] as PreparedImage, a.box)),
      );
      const identification = await vision.identify(
        crops,
        frames[best[0]?.frame ?? 0] as PreparedImage,
        object.label,
      );
      if (!identification.is_tradeable_item) return null;
      return { index, object, crops, identification } satisfies Candidate;
    } catch (err) {
      logger.error("appraiser_item_failed", { capture_id: captureId, index, error: String(err) });
      return null;
    }
  });

  // 2. Fold double counts: look-alikes in the same frame that are really 1 thing to trade.
  const kept = await consolidate(
    identified.filter((c): c is Candidate => c !== null),
    frames,
    vision,
    logger,
  );

  // 3. Price and save.
  let saved = 0;
  await mapLimit(kept, PARALLEL_ITEMS, async ({ index, crops, identification }) => {
    try {
      await store.setProgress(captureId, {
        stage: "pricing",
        detail: `Pricing your ${identification.title}`,
        found: kept.length,
      });
      const { value, research } = await vision.price(identification);

      const confident =
        identification.identity_confidence >= CONFIDENCE_THRESHOLD &&
        identification.condition_confidence >= CONFIDENCE_THRESHOLD;
      const mainCrop = crops[0] as PreparedImage;
      const cropPath = `${userId}/${captureId}/crops/${index}.jpg`;
      await store.upload(cropPath, mainCrop.jpeg);

      const itemId = await store.insertItem({
        userId,
        captureId,
        status: confident ? "on_shelf" : "needs_photos",
        title: identification.title,
        identification: {
          ...identification,
          follow_up: confident ? null : (identification.follow_up ?? "1 more photo, up close"),
        },
        value,
        cropPath,
        crop: mainCrop,
        comps: { research, basis: value?.basis ?? [] },
      });
      saved++;

      try {
        const text = [
          identification.title,
          identification.brand,
          identification.model,
          identification.category,
        ]
          .filter(Boolean)
          .join(" | ");
        await store.saveEmbedding(
          itemId,
          embedder.model,
          await embedder.embed(text, mainCrop.jpeg),
        );
      } catch (err) {
        // Matching can backfill embeddings later; the Item itself is still useful now.
        logger.warn("appraiser_embedding_failed", { item_id: itemId, error: String(err) });
      }
    } catch (err) {
      logger.error("appraiser_item_failed", { capture_id: captureId, index, error: String(err) });
    }
  });

  await store.finishCapture(captureId, saved, {
    stage: "done",
    detail:
      saved > 0
        ? `Added ${plural(saved, "item")} to your Shelf`
        : "Couldn't read these. Try again with better light.",
    found: saved,
  });
  return saved;
}
