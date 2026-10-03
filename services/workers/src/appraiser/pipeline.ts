import { randomUUID } from "node:crypto";
import type { Logger } from "../log.js";
import { MAX_GROUP_CANDIDATES, type ModelRun, type PriceResult, type Vision } from "./claude.js";
import type { Embedder } from "./embeddings.js";
import {
  type Box,
  boxArea,
  contextRegion,
  crop,
  cropRegion,
  fromRegion,
  isBetterHero,
  isDegenerate,
  type PreparedImage,
  prepare,
  SOURCE_EDGE,
  sharpness,
} from "./images.js";
import { CachedPricer, type PriceCacheStore, productKey } from "./price-cache.js";
import { looksPrivate } from "./privacy.js";
import type { DetectedObject, Identification, ValueEstimate } from "./schemas.js";

/** Items need both confidences at or above this to go straight onto the Shelf (PRD). */
export const CONFIDENCE_THRESHOLD = 0.7;
const MAX_ITEMS = 12;
const DEFAULT_FOLLOW_UP = "1 more photo, up close";

/** Concurrency knobs (env: PARALLEL_IDENTIFY, PARALLEL_PRICING). */
export interface PipelineConfig {
  /** Sonnet vision calls at once. Each carries 3 images, so keep this modest. */
  parallelIdentify: number;
  /** Items priced at once. Research is slow and mostly waiting, so this can be higher. */
  parallelPricing: number;
}

export const DEFAULT_PIPELINE: PipelineConfig = { parallelIdentify: 5, parallelPricing: 10 };

export interface CaptureMedia {
  path: string;
  position: number;
  sharpness: number | null;
}

/** An identified Item, saved before pricing so the user sees it right away. */
export interface NewItem {
  userId: string;
  captureId: string;
  /** Always on_shelf: readiness, not status, carries what an Item still needs. */
  status: "on_shelf";
  title: string;
  identification: Identification;
  cropPath: string;
  crop: PreparedImage;
  /** Where the crop was cut: frame (media position), box in that frame, and its source. */
  cropBox: Located;
}

/** What pricing produced for an Item. A null value means pricing failed; the Item stays. */
export interface PricedItem {
  identification: Identification;
  value: ValueEstimate | null;
  model: string;
  comps: { research: string; basis: string[]; cached: boolean };
}

export interface ItemMedia {
  id: string;
  path: string;
  position: number;
  createdAt: Date;
}

/** An Item as the reappraisal job needs it. */
export interface StoredItem {
  id: string;
  userId: string;
  appraising: boolean;
  identification: Identification;
  hasValue: boolean;
  media: ItemMedia[];
}

export interface ReappraisedItem {
  identification: Identification;
  /** Always on_shelf: readiness, not status, carries what an Item still needs. */
  status: "on_shelf";
  /** Present only when the Item was priced again. */
  priced?: PricedItem;
  inputMediaIds: string[];
}

export interface Progress {
  stage: "detecting" | "identifying" | "pricing" | "done" | "failed";
  detail: string;
  found?: number;
}

/** Everything the Appraiser reads and writes. Supabase in production, memory in tests. */
export interface AppraiserStore extends PriceCacheStore {
  loadCapture(captureId: string): Promise<{ userId: string; media: CaptureMedia[] } | null>;
  /** Removes Items a previous, failed attempt at this capture saved, so a retry can't duplicate. */
  clearCaptureItems(captureId: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  upload(path: string, jpeg: Buffer): Promise<void>;
  setProgress(captureId: string, progress: Progress): Promise<void>;
  /** Saves an identified Item with no value yet and appraising = true. Returns its ID. */
  insertItem(item: NewItem): Promise<string>;
  /** Writes the value (or leaves it null), appends the appraisal and clears appraising. */
  finishItem(itemId: string, priced: PricedItem): Promise<void>;
  saveEmbedding(itemId: string, model: string, vector: number[]): Promise<void>;
  finishCapture(captureId: string, itemCount: number, progress: Progress): Promise<void>;
  /** Marks the capture failed and clears appraising on any Items it saved. */
  failCapture(captureId: string, message: string): Promise<void>;
  recordRun(userId: string, run: ModelRun, trigger?: string): Promise<void>;

  /** The user's Item with its media, or null when missing, removed or someone else's. */
  loadItem(itemId: string, userId: string): Promise<StoredItem | null>;
  /** Updates the Item in place after new photos, appends an appraisal, clears appraising. */
  saveReappraisal(itemId: string, update: ReappraisedItem): Promise<void>;
  /** Adds an image as the Item's first photo (position 0), shifting the others down. */
  addHero(itemId: string, path: string, image: PreparedImage): Promise<void>;
  setAppraising(itemId: string, appraising: boolean): Promise<void>;
}

export interface AppraiserDeps {
  store: AppraiserStore;
  vision: Vision;
  embedder: Embedder;
  logger: Logger;
  /** Defaults to pricing through the store's cache with default settings. */
  pricer?: Pick<CachedPricer, "price">;
  config?: PipelineConfig;
  /** Called once a capture's Item is priced, to hand it to the Refiner. Errors are logged. */
  onItemFinished?: (itemId: string, userId: string) => Promise<void>;
}

/** Runs async work over items with a concurrency limit, keeping input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

const isConfident = (id: Identification) =>
  id.identity_confidence >= CONFIDENCE_THRESHOLD && id.condition_confidence >= CONFIDENCE_THRESHOLD;

/**
 * Every Item goes on the Shelf (PRD "Log, don't block"). A low-confidence reading keeps the
 * 1 photo that would settle it as a hint for the Refiner, which asks the cheapest useful
 * question first and a photo last.
 */
function settle(id: Identification) {
  const confident = isConfident(id);
  return {
    status: "on_shelf" as const,
    identification: { ...id, follow_up: confident ? null : (id.follow_up ?? DEFAULT_FOLLOW_UP) },
  };
}

const embeddingText = (id: Identification) =>
  [id.title, id.brand, id.model, id.category].filter(Boolean).join(" | ");

async function embed(deps: AppraiserDeps, itemId: string, id: Identification, jpeg: Buffer) {
  try {
    const vector = await deps.embedder.embed(embeddingText(id), jpeg);
    await deps.store.saveEmbedding(itemId, deps.embedder.model, vector);
  } catch (err) {
    // Matching can backfill embeddings later; the Item itself is still useful now.
    deps.logger.warn("appraiser_embedding_failed", { item_id: itemId, error: String(err) });
  }
}

const pricedFrom = (identification: Identification, result: PriceResult & { cached?: boolean }) =>
  ({
    identification,
    value: result.value,
    model: result.model,
    comps: {
      research: result.research,
      basis: result.value?.basis ?? [],
      cached: result.cached ?? false,
    },
  }) satisfies PricedItem;

/** Picks the appearance to crop from: the largest box, tie-broken by frame sharpness. */
export function bestAppearances(object: DetectedObject, media: CaptureMedia[], count = 2) {
  const sharpness = (frame: number) => media[frame]?.sharpness ?? 0;
  return [...object.appearances]
    .filter((a) => a.frame < media.length && boxArea(a.box) > 0.0005)
    .sort((a, b) => boxArea(b.box) - boxArea(a.box) || sharpness(b.frame) - sharpness(a.frame))
    .slice(0, count);
}

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

/** Where an Item sits in 1 frame. Refined boxes come from identification's second pass. */
export interface Located {
  frame: number;
  box: Box;
  source: "refined" | "detector";
}

/** A context close-up sent to identification, and the frame region it was cut from. */
interface CloseUp {
  frame: number;
  region: Box;
  detectorBox: Box;
  image: PreparedImage;
}

interface Candidate {
  index: number;
  object: DetectedObject;
  closeUps: CloseUp[];
  identification: Identification;
  located: Located[];
  /** Tight crop for the contact sheet and the hero image. */
  hero: { located: Located; image: PreparedImage };
}

/** Smallest refined box, as a share of the frame, still worth trusting. */
const MIN_FRAME_AREA = 0.0005;

/**
 * Maps identification's tight boxes (normalized to each close-up) back to the frame. A
 * close-up with no box, or a degenerate one, falls back to the detector's box for it.
 */
export function localize(
  closeUps: Pick<CloseUp, "frame" | "region" | "detectorBox">[],
  identification: Identification,
): Located[] {
  return closeUps.map((c, i) => {
    const found = identification.box_in_crop?.find((b) => b.crop === i + 1);
    if (found && !isDegenerate(found.box)) {
      const box = fromRegion(found.box, c.region);
      if (boxArea(box) >= MIN_FRAME_AREA) return { frame: c.frame, box, source: "refined" };
    }
    return { frame: c.frame, box: c.detectorBox, source: "detector" };
  });
}

/**
 * The hero frame: the largest refined box times that frame's sharpness. Detector boxes are
 * coarse and usually larger, so they only compete when nothing was refined.
 */
export function pickHero(located: Located[], sharpness: (frame: number) => number): Located {
  const refined = located.filter((l) => l.source === "refined");
  const pool = refined.length > 0 ? refined : located;
  const score = (l: Located) => boxArea(l.box) * (1 + Math.max(0, sharpness(l.frame)));
  return pool.reduce((best, l) => (score(l) > score(best) ? l : best));
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

/**
 * 1 Haiku call for the whole capture: a numbered contact sheet of every candidate's tight
 * crop, title and frames, answered with groups that are 1 thing to trade (the same object
 * seen twice under different titles, or the parts of 1 thing). Keeps the most confident
 * reading per group with every member's appearances. On any error, keeps everything.
 */
export async function consolidate<
  C extends {
    index: number;
    object: DetectedObject;
    identification: Identification;
    located: Located[];
    hero: { image: PreparedImage };
  },
>(candidates: C[], vision: Vision, logger: Logger): Promise<C[]> {
  if (candidates.length < 2) return candidates;
  const considered = candidates.slice(0, MAX_GROUP_CANDIDATES);
  let groups: number[][] = [];
  try {
    groups = await vision.group(
      considered.map((c) => ({
        crop: c.hero.image,
        title: c.identification.title,
        frames: [...new Set(c.object.appearances.map((a) => a.frame))].sort((a, b) => a - b),
      })),
    );
  } catch (err) {
    logger.warn("appraiser_group_failed", { error: String(err) });
    return candidates;
  }

  const parent = candidates.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : root(parent[i] as number));
  for (const g of groups) {
    const valid = g.filter((m) => m >= 0 && m < considered.length);
    for (const m of valid.slice(1)) parent[root(m)] = root(valid[0] as number);
  }

  const members = new Map<number, C[]>();
  candidates.forEach((c, i) => {
    const r = root(i);
    members.set(r, [...(members.get(r) ?? []), c]);
  });
  const confidence = (c: C) =>
    c.identification.identity_confidence + c.identification.condition_confidence / 100;
  const kept = [...members.values()].map((group) => {
    const best = group.reduce((a, b) => (confidence(b) > confidence(a) ? b : a));
    if (group.length === 1) return best;
    const appearances = group.flatMap((c) => c.object.appearances);
    return {
      ...best,
      object: { ...best.object, appearances },
      located: group.flatMap((c) => c.located),
    };
  });
  kept.sort((a, b) => a.index - b.index);
  if (kept.length < candidates.length) {
    logger.info("appraiser_consolidated", {
      before: candidates.length,
      after: kept.length,
      groups: groups.length,
    });
  }
  return kept;
}

/**
 * Each frame's sharpness: the device's score when every frame has one (the iOS app and the
 * eval runner both send it), otherwise our own, so 1 capture never mixes 2 scales.
 */
async function sharpnessOf(media: CaptureMedia[], sources: PreparedImage[]) {
  const scores = media.every((m) => m.sharpness !== null)
    ? media.map((m) => m.sharpness as number)
    : await Promise.all(sources.map((s) => sharpness(s)));
  return (frame: number) => scores[frame] ?? 0;
}

/** Cuts the hero image from the full-resolution frame at the chosen box. */
async function heroCrop(
  located: Located[],
  sources: PreparedImage[],
  sharpnessAt: (frame: number) => number,
  current?: { located: Located; image: PreparedImage },
) {
  const pick = pickHero(located, sharpnessAt);
  if (current && current.located.frame === pick.frame && current.located.box === pick.box) {
    return current;
  }
  return { located: pick, image: await crop(sources[pick.frame] as PreparedImage, pick.box) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Capture to Items: prepare frames, detect objects across frames (deduplicated by the
 * detector), crop each from its best frames, identify and grade, then save every Item right
 * away with appraising = true so the Shelf fills in while pricing runs. Each Item is then
 * priced (through the shared cache) and embedded in place. The capture is done only when
 * every Item is finished. Every Item lands on_shelf; the Refiner takes over from there.
 */
export async function appraiseCapture(captureId: string, deps: AppraiserDeps): Promise<number> {
  const { store, vision, logger } = deps;
  const config = deps.config ?? DEFAULT_PIPELINE;
  const pricer = deps.pricer ?? new CachedPricer(vision, store);
  const capture = await store.loadCapture(captureId);
  if (!capture) throw new Error(`capture ${captureId} not found`);
  const { userId } = capture;
  const media = [...capture.media].sort((a, b) => a.position - b.position);
  if (media.length === 0) throw new Error("capture has no media");
  await store.clearCaptureItems(captureId);

  await store.setProgress(captureId, { stage: "detecting", detail: "Looking at your photos" });
  // Full resolution for cutting crops; Claude sees frames at MAX_EDGE.
  const sources = await Promise.all(
    media.map(async (m) => prepare(await store.download(m.path), SOURCE_EDGE)),
  );
  const frames = await Promise.all(sources.map((s) => prepare(s.jpeg)));
  const frameSharpness = sharpnessOf(media, sources);

  const detection = await vision.detect(frames);
  const merged = mergeNested(detection.objects);
  // Private things never get a close-up read: no identify call, nothing saved.
  const objects = merged
    .filter((o) => !looksPrivate(o.label, o.category))
    .map((o) => ({ object: o, best: bestAppearances(o, media) }))
    .filter((o) => o.best.length > 0)
    .slice(0, MAX_ITEMS);
  logger.info("appraiser_detected", {
    capture_id: captureId,
    detected: detection.objects.length,
    private_skipped: merged.filter((o) => looksPrivate(o.label, o.category)).length,
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

  // 1. Identify and grade every object from wide context close-ups, and localize it: the
  //    model returns a tight box per close-up, which replaces the detector's coarse box.
  const identified = await mapLimit(
    objects,
    config.parallelIdentify,
    async ({ object, best }, index) => {
      try {
        const closeUps: CloseUp[] = await Promise.all(
          best.map(async (a) => {
            const region = contextRegion(a.box);
            const image = await cropRegion(sources[a.frame] as PreparedImage, region);
            return { frame: a.frame, region, detectorBox: a.box, image };
          }),
        );
        const identification = await vision.identify(
          closeUps.map((c) => c.image),
          frames[best[0]?.frame ?? 0] as PreparedImage,
          object.label,
        );
        if (!identification.is_tradeable_item) return null;
        if (looksPrivate(identification.title, identification.category)) return null;
        const located = localize(closeUps, identification);
        const hero = await heroCrop(located, sources, await frameSharpness);
        return { index, object, closeUps, identification, located, hero } satisfies Candidate;
      } catch (err) {
        logger.error("appraiser_item_failed", { capture_id: captureId, index, error: String(err) });
        return null;
      }
    },
  );
  const candidates = identified.filter((c): c is Candidate => c !== null);
  logger.info("appraiser_localized", {
    capture_id: captureId,
    close_ups: candidates.reduce((n, c) => n + c.located.length, 0),
    refined: candidates.reduce(
      (n, c) => n + c.located.filter((l) => l.source === "refined").length,
      0,
    ),
  });

  // 2. Fold double counts across the whole capture in 1 call: the same object seen in
  //    several frames under different titles, or the parts of 1 thing.
  const kept = await consolidate(candidates, vision, logger);

  // 3. Save every Item now, unpriced, so the user sees them while pricing runs.
  const saved = (
    await mapLimit(kept, 4, async (candidate) => {
      const { index, identification: raw } = candidate;
      try {
        const { status, identification } = settle(raw);
        // A merged group may have a better view of the item than its winner's own.
        const hero =
          candidate.located.length > 0
            ? await heroCrop(candidate.located, sources, await frameSharpness, candidate.hero)
            : candidate.hero;
        const cropPath = `${userId}/${captureId}/crops/${index}.jpg`;
        await store.upload(cropPath, hero.image.jpeg);
        const itemId = await store.insertItem({
          userId,
          captureId,
          status,
          title: identification.title,
          identification,
          cropPath,
          crop: hero.image,
          cropBox: {
            frame: media[hero.located.frame]?.position ?? hero.located.frame,
            box: hero.located.box,
            source: hero.located.source,
          },
        });
        return { itemId, identification, mainCrop: hero.image };
      } catch (err) {
        logger.error("appraiser_item_failed", { capture_id: captureId, index, error: String(err) });
        return null;
      }
    })
  ).filter((s) => s !== null);

  if (saved.length > 0) {
    await store.setProgress(captureId, {
      stage: "pricing",
      detail: `Found ${plural(saved.length, "item")}. Pricing them now`,
      found: saved.length,
    });
  }

  // 4. Price and embed each Item in place. A pricing failure leaves the value null.
  let priced = 0;
  await mapLimit(saved, config.parallelPricing, async ({ itemId, identification, mainCrop }) => {
    const embedding = embed(deps, itemId, identification, mainCrop.jpeg);
    let result: PricedItem = {
      identification,
      value: null,
      model: "none",
      comps: { research: "", basis: [], cached: false },
    };
    try {
      result = pricedFrom(identification, await pricer.price(identification));
    } catch (err) {
      logger.error("appraiser_price_failed", { item_id: itemId, error: String(err) });
    }
    try {
      await store.finishItem(itemId, result);
      if (deps.onItemFinished) {
        await deps
          .onItemFinished(itemId, userId)
          .catch((err) =>
            logger.warn("appraiser_refine_handoff_failed", { item_id: itemId, error: String(err) }),
          );
      }
    } catch (err) {
      logger.error("appraiser_finish_item_failed", { item_id: itemId, error: String(err) });
      await store.setAppraising(itemId, false).catch(() => {});
    }
    await embedding;
    priced++;
    if (priced < saved.length) {
      await store
        .setProgress(captureId, {
          stage: "pricing",
          detail: `Priced ${priced} of ${saved.length}`,
          found: saved.length,
        })
        .catch(() => {});
    }
  });

  await store.finishCapture(captureId, saved.length, {
    stage: "done",
    detail:
      saved.length > 0
        ? `Added ${plural(saved.length, "item")} to your Shelf`
        : "Couldn't read these. Try again with better light.",
    found: saved.length,
  });
  return saved.length;
}

/**
 * Whether a new reading is a different thing to price: another product, edition or
 * variant, or another condition grade. Confidence changes alone are not.
 */
export function changedMaterially(before: Identification, after: Identification) {
  if (before.condition_grade !== after.condition_grade) return true;
  const [a, b] = [productKey(before), productKey(after)];
  if (a !== null && a === b) return false;
  if ((before.model ?? null) === null && (after.model ?? null) === null) {
    const same = (x: string | null, y: string | null) =>
      (x ?? "").trim().toLowerCase() === (y ?? "").trim().toLowerCase();
    if (!same(before.variant, after.variant)) return true;
    return !(same(before.brand, after.brand) && titleOverlap(before.title, after.title) >= 0.6);
  }
  return true;
}

/** The newest batch of follow-up photos: rows written by 1 submit share a timestamp. */
function latestBatch(media: ItemMedia[], heroId: string | undefined) {
  const extra = media.filter((m) => m.id !== heroId);
  const newest = Math.max(...extra.map((m) => m.createdAt.getTime()));
  return extra
    .filter((m) => m.createdAt.getTime() === newest)
    .sort((a, b) => a.position - b.position)
    .slice(0, 5);
}

/**
 * Follow-up photos to an updated Item: reads it again from its hero image and the owner's
 * new photos, prices again only when the identity changed materially (or it never had a
 * value), promotes a better photo to the hero image, and saves it all in place. Throws on
 * failure so the job retries; the caller clears appraising after the last attempt.
 */
export async function reappraiseItem(
  itemId: string,
  userId: string,
  deps: AppraiserDeps,
): Promise<"updated" | "skipped"> {
  const { store, vision, logger } = deps;
  const pricer = deps.pricer ?? new CachedPricer(vision, store);
  const item = await store.loadItem(itemId, userId);
  if (!item) {
    logger.warn("reappraise_missing_item", { item_id: itemId });
    return "skipped";
  }
  if (!item.appraising) {
    // A duplicate or stale job: the Item was already finished.
    logger.info("reappraise_not_appraising", { item_id: itemId });
    return "skipped";
  }

  const ordered = [...item.media].sort((a, b) => a.position - b.position);
  const heroRow = ordered[0];
  const batch = latestBatch(ordered, heroRow?.id);
  if (!heroRow || batch.length === 0) {
    logger.warn("reappraise_no_photos", { item_id: itemId });
    await store.setAppraising(itemId, false);
    return "skipped";
  }

  const [hero, ...photos] = await Promise.all(
    [heroRow, ...batch].map(async (m) => prepare(await store.download(m.path))),
  );
  const next = await vision.reidentify(item.identification, hero as PreparedImage, photos);

  // New photos of something private (or not a possession) never change the Item.
  if (!next.is_tradeable_item || looksPrivate(next.title, next.category)) {
    logger.info("reappraise_not_tradeable", { item_id: itemId });
    await store.setAppraising(itemId, false);
    return "skipped";
  }

  const { status, identification } = settle(next);
  const reprice = !item.hasValue || changedMaterially(item.identification, identification);
  let priced: PricedItem | undefined;
  if (reprice) {
    try {
      priced = pricedFrom(identification, await pricer.price(identification));
    } catch (err) {
      // A different product with a failed price must not keep the old product's value.
      logger.error("appraiser_price_failed", { item_id: itemId, error: String(err) });
      priced = {
        identification,
        value: null,
        model: "none",
        comps: { research: "", basis: [], cached: false },
      };
    }
  }

  // Promote the best new photo when it beats the current hero (larger and sharper).
  let heroImage = hero as PreparedImage;
  let best: PreparedImage | null = null;
  for (const photo of photos) {
    if (await isBetterHero(photo, best ?? heroImage)) best = photo;
  }
  if (best) {
    // A re-encoded copy: rotated, at most 1000 px, and stripped of EXIF such as location.
    const heroPath = `${userId}/items/${itemId}/hero-${randomUUID()}.jpg`;
    await store.upload(heroPath, best.jpeg);
    await store.addHero(itemId, heroPath, best);
    heroImage = best;
  }

  await store.saveReappraisal(itemId, {
    identification,
    status,
    ...(priced && { priced }),
    inputMediaIds: [heroRow.id, ...batch.map((m) => m.id)],
  });

  if (reprice || best) await embed(deps, itemId, identification, heroImage.jpeg);
  logger.info("reappraise_done", {
    item_id: itemId,
    status,
    repriced: reprice,
    new_hero: best !== null,
  });
  return "updated";
}
