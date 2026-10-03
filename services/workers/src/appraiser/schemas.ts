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
  attributes: z
    .array(z.object({ name: z.string().max(60), value: z.string().max(200) }))
    .max(20)
    .transform((pairs) => Object.fromEntries(pairs.map((p) => [p.name, p.value]))),
  condition_grade: z.enum(["A", "B", "C", "D"]),
  defects: z.array(z.string().max(120)).max(10),
  age_estimate_years: z
    .array(z.number())
    .nullable()
    .transform((v) => (v && v.length >= 2 ? ([v[0], v[1]] as [number, number]) : null)),
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

/**
 * JSON Schemas for Claude's structured outputs (`output_config.format`). The API adds
 * `additionalProperties: false` to every object and ignores numeric and length bounds, so
 * free-form maps are arrays of name and value pairs and bounds live in descriptions.
 * The zod parsers above enforce the real constraints.
 */
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });

export const detectionJsonSchema = {
  type: "object",
  properties: {
    objects: {
      type: "array",
      description: "At most 20 objects",
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
                  description:
                    "Exactly 4 numbers: [x0, y0, x1, y1], normalized 0 to 1, tight around the object",
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

export const identificationJsonSchema = {
  type: "object",
  properties: {
    is_tradeable_item: {
      type: "boolean",
      description: "False for furniture, people, pets, or anything not a tradeable possession",
    },
    title: {
      type: "string",
      description:
        "What a collector would call it, e.g. 'LEGO Batmobile Tumbler 76240'. At most 120 characters.",
    },
    category: { type: "string" },
    brand: nullable({ type: "string" }),
    model: nullable({
      type: "string",
      description: "Set number, SKU or model name if visible or certain",
    }),
    variant: nullable({ type: "string" }),
    attributes: {
      type: "array",
      description:
        "Facts seen in the photos, e.g. {name: 'box', value: 'yes'}, {name: 'size', value: '10'}",
      items: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
      },
    },
    condition_grade: { type: "string", enum: ["A", "B", "C", "D"] },
    defects: { type: "array", items: { type: "string" } },
    age_estimate_years: nullable({
      type: "array",
      items: { type: "number" },
      description: "[min, max] years",
    }),
    identity_confidence: { type: "number", description: "0 to 1" },
    condition_confidence: { type: "number", description: "0 to 1" },
    follow_up: nullable({
      type: "string",
      description:
        "If either confidence is below 0.7, the 1 photo that would settle it, e.g. 'Photo of the size tag'",
    }),
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

export const valueJsonSchema = {
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
    confidence: { type: "number", description: "0 to 1" },
  },
  required: ["low_usd", "mid_usd", "high_usd", "basis", "confidence"],
} as const;
