import { basename } from "node:path";
import { type CaptureCase, CaptureCase as CaptureCaseSchema } from "./cases.js";
import type { PredictedItem } from "./match.js";

/** A case id from a folder or file name: lowercase words joined by dashes. */
export function slug(name: string) {
  const s = basename(name)
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "capture";
}

/**
 * A draft capture case with every prediction prefilled as an unreviewed label. A human
 * fixes titles, ranges and grades, deletes what shouldn't be an Item (and lists it under
 * `forbidden`), adds what was missed, and sets `reviewed: true` on each label.
 */
export function draftCase(id: string, media: string[], predicted: PredictedItem[]): CaptureCase {
  const draft = {
    version: 2,
    id: `appraisal-${id}`.replace(/^appraisal-appraisal-/, "appraisal-"),
    suite: "appraisal",
    description: `Draft from label assist for ${media.join(", ")}. Describe the scene.`,
    media,
    items: predicted.map((p) => ({
      title: p.title,
      aliases: [],
      category: p.category,
      brand: p.brand,
      model: p.model,
      condition_grade: p.condition_grade,
      value_cents_low: p.value?.low ?? 0,
      value_cents_high: p.value?.high ?? 0,
      should_ask_for_photo: p.follow_up !== null,
      reviewed: false,
      ...(p.value ? {} : { notes: "The Appraiser returned no price. Fill in an honest range." }),
    })),
    forbidden: [],
  };
  return CaptureCaseSchema.parse(draft);
}
