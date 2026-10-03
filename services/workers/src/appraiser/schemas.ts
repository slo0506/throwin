import { z } from "zod";

/** A box in normalized frame coordinates: [x0, y0, x1, y1], each 0 to 1. */
export const Box = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .transform(([a, b, c, d]) => {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const [x0, x1] = [clamp(Math.min(a, c)), clamp(Math.max(a, c))];
    const [y0, y1] = [clamp(Math.min(b, d)), clamp(Math.max(b, d))];
    return [x0, y0, x1, y1] as [number, number, number, number];
  });

/** Detection output: distinct physical objects, each with every frame it appears in. */
export const Detection = z.object({
  objects: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        category: z.string().max(60),
        appearances: z.array(z.object({ frame: z.number().int().min(0), box: Box })).min(1),
      }),
    )
    .max(20),
});
export type Detection = z.infer<typeof Detection>;
export type DetectedObject = Detection["objects"][number];

/** Identification and grading (PRD "Appraisal output", minus value). */
export const Identification = z.object({
  is_tradeable_item: z.boolean(),
  title: z.string().min(1).max(120),
  category: z.string().max(60),
  brand: z.string().max(60).nullable(),
  model: z.string().max(80).nullable(),
  variant: z.string().max(80).nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  condition_grade: z.enum(["A", "B", "C", "D"]),
  defects: z.array(z.string().max(120)).max(10),
  age_estimate_years: z.tuple([z.number(), z.number()]).nullable(),
  identity_confidence: z.number().min(0).max(1),
  condition_confidence: z.number().min(0).max(1),
  follow_up: z.string().max(160).nullable(),
});
export type Identification = z.infer<typeof Identification>;

export const ValueEstimate = z
  .object({
    low_usd: z.number().nonnegative(),
    mid_usd: z.number().nonnegative(),
    high_usd: z.number().nonnegative(),
    basis: z.array(z.string().max(200)).max(10),
    confidence: z.number().min(0).max(1),
  })
  .transform((v) => {
    const [low, mid, high] = [v.low_usd, v.mid_usd, v.high_usd].sort((a, b) => a - b) as [
      number,
      number,
      number,
    ];
    return { ...v, low_usd: low, mid_usd: mid, high_usd: high };
  });
export type ValueEstimate = z.infer<typeof ValueEstimate>;

/** JSON Schemas handed to Claude as forced tool inputs. Kept next to the zod parsers. */
export const detectionToolSchema = {
  type: "object",
  properties: {
    objects: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Short name, e.g. 'LEGO set in box' or 'Nintendo Switch game case'",
          },
          category: {
            type: "string",
            description:
              "e.g. toys/lego, video_games, sneakers, books, trading_cards, electronics, other",
          },
          appearances: {
            type: "array",
            items: {
              type: "object",
              properties: {
                frame: { type: "integer", description: "0-based index of the image" },
                box: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 4,
                  maxItems: 4,
                  description: "[x0, y0, x1, y1] normalized 0 to 1, tight around the object",
                },
              },
              required: ["frame", "box"],
            },
          },
        },
        required: ["label", "category", "appearances"],
      },
    },
  },
  required: ["objects"],
} as const;

export const identificationToolSchema = {
  type: "object",
  properties: {
    is_tradeable_item: {
      type: "boolean",
      description: "False for furniture, people, pets, or anything not a tradeable possession",
    },
    title: {
      type: "string",
      description: "What a collector would call it, e.g. 'LEGO Batmobile Tumbler 76240'",
    },
    category: { type: "string" },
    brand: { type: ["string", "null"] },
    model: {
      type: ["string", "null"],
      description: "Set number, SKU or model name if visible or certain",
    },
    variant: { type: ["string", "null"] },
    attributes: {
      type: "object",
      description: "Facts seen in the photos, e.g. {complete: 'unknown', box: true, size: '10'}",
    },
    condition_grade: { type: "string", enum: ["A", "B", "C", "D"] },
    defects: { type: "array", items: { type: "string" } },
    age_estimate_years: {
      type: ["array", "null"],
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    },
    identity_confidence: { type: "number", minimum: 0, maximum: 1 },
    condition_confidence: { type: "number", minimum: 0, maximum: 1 },
    follow_up: {
      type: ["string", "null"],
      description:
        "If either confidence is below 0.7, the 1 photo that would settle it, e.g. 'Photo of the size tag'",
    },
  },
  required: [
    "is_tradeable_item",
    "title",
    "category",
    "brand",
    "model",
    "variant",
    "attributes",
    "condition_grade",
    "defects",
    "age_estimate_years",
    "identity_confidence",
    "condition_confidence",
    "follow_up",
  ],
} as const;

export const valueToolSchema = {
  type: "object",
  properties: {
    low_usd: { type: "number" },
    mid_usd: { type: "number" },
    high_usd: { type: "number" },
    basis: {
      type: "array",
      items: { type: "string" },
      description: "Each comparable used, e.g. 'eBay sold 2026-09: $210, box, complete'",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["low_usd", "mid_usd", "high_usd", "basis", "confidence"],
} as const;
