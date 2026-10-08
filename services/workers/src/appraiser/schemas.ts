import { ProhibitedReason } from "@throwin/shared";
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

/**
 * Text the model writes. Structured outputs can't enforce lengths, so trim instead of
 * rejecting: 1 character over a limit should never cost the user an Item.
 */
const text = (max: number) =>
  z.string().transform((v) => {
    // Drop a leaked JSON tail like `"}` that sometimes ends a field.
    const clean = v.replace(/"\s*\}+\s*$/u, "").trim();
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
  });
const optionalText = (max: number) =>
  z
    .string()
    .nullable()
    .transform((v) => {
      const trimmed = v === null ? "" : text(max).parse(v);
      return trimmed.length > 0 ? trimmed : null;
    });

/** Detection output: distinct physical objects, each with every frame it appears in. */
export const Detection = z.object({
  objects: z
    .array(
      z.object({
        label: text(120).pipe(z.string().min(1)),
        category: text(60),
        appearances: z.array(z.object({ frame: z.number().int().min(0), box: Box })).min(1),
      }),
    )
    .max(20),
  /**
   * Things seen that Throw-In can't trade, by reason only: no labels, so a person or a
   * private thing is never described. Optional in code; always requested from the model.
   */
  not_tradeable: z
    .array(z.object({ reason: ProhibitedReason }))
    .transform((r) => r.slice(0, 20))
    .optional(),
});
export type Detection = z.infer<typeof Detection>;
export type DetectedObject = Detection["objects"][number];

/** Identification and grading (PRD "Appraisal output", minus value). */
export const Identification = z.object({
  is_tradeable_item: z.boolean(),
  /** Set when the item is something Throw-In can't trade. Optional in code (stored Items have none). */
  prohibited_reason: ProhibitedReason.nullable().optional(),
  title: text(120).pipe(z.string().min(1)),
  category: text(60),
  brand: optionalText(60),
  model: optionalText(80),
  variant: optionalText(80),
  attributes: z
    .array(z.object({ name: text(60), value: text(200) }))
    .transform((pairs) => pairs.slice(0, 20))
    .transform((pairs) => Object.fromEntries(pairs.map((p) => [p.name, p.value]))),
  condition_grade: z.enum(["A", "B", "C", "D"]),
  defects: z.array(text(120)).transform((d) => d.slice(0, 10)),
  age_estimate_years: z
    .array(z.number())
    .nullable()
    .transform((v) => (v && v.length >= 2 ? ([v[0], v[1]] as [number, number]) : null)),
  identity_confidence: z.number().min(0).max(1),
  condition_confidence: z.number().min(0).max(1),
  follow_up: optionalText(160),
  /**
   * Second localization pass: a tight box around the named item in each close-up where it
   * is visible, normalized to that close-up. Optional in code (follow-up readings and
   * stored Items have none); always requested from the model.
   */
  box_in_crop: z
    .array(z.object({ crop: z.number(), box: z.array(z.number()) }))
    // A malformed box is dropped (the detector's box is the fallback), never a lost Item.
    .transform((entries) =>
      entries
        .flatMap((e) =>
          Number.isInteger(e.crop) && e.box.length === 4
            ? [{ crop: e.crop, box: Box.parse(e.box) }]
            : [],
        )
        .slice(0, 5),
    )
    .optional(),
});
export type Identification = z.infer<typeof Identification>;
export type CropBox = NonNullable<Identification["box_in_crop"]>[number];

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

/** Structured outputs require `additionalProperties: false` on every object, explicitly. */
export function strict<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(strict) as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = strict(v);
  if (out.type === "object") out.additionalProperties = false;
  return out as T;
}

export const detectionJsonSchema = strict({
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
    not_tradeable: {
      type: "array",
      description:
        "1 entry per thing you saw but left out because Throw-In can't trade it. Reason only, no label.",
      items: {
        type: "object",
        properties: { reason: { type: "string", enum: ProhibitedReason.options } },
        required: ["reason"],
      },
    },
  },
  required: ["objects", "not_tradeable"],
} as const);

export const identificationJsonSchema = strict({
  type: "object",
  properties: {
    is_tradeable_item: {
      type: "boolean",
      description:
        "False for furniture, fixtures, people, pets, medications, supplements, medical devices, personal hygiene items, documents, IDs, bank or credit cards, anything Throw-In can't trade, or anything not a tradeable possession",
    },
    prohibited_reason: nullable({
      type: "string",
      enum: ProhibitedReason.options,
      description: "Set only when the item is something Throw-In can't trade; null otherwise",
    }),
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
        "If either confidence is below 0.7, the 1 photo that would settle it, under 60 characters, e.g. 'Photo of the size tag'",
    }),
    box_in_crop: {
      type: "array",
      description:
        "For each close-up (numbered from 1) where the item you named is visible: a tight box around all of that item and nothing else. Empty if it is not visible in any close-up.",
      items: {
        type: "object",
        properties: {
          crop: { type: "integer", description: "Which close-up, numbered from 1" },
          box: {
            type: "array",
            items: { type: "number" },
            description:
              "Exactly 4 numbers: [x0, y0, x1, y1], normalized 0 to 1 within that close-up (0,0 is its top left)",
          },
        },
        required: ["crop", "box"],
      },
    },
  },
  required: [
    "is_tradeable_item",
    "prohibited_reason",
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
    "box_in_crop",
  ],
} as const);

/**
 * Capture-level consolidation: groups of candidate numbers that are 1 thing to trade.
 * Candidates in no group stay separate.
 */
export const Groups = z.object({
  groups: z.array(z.object({ members: z.array(z.number().int()), reason: z.string() })),
});
export type Groups = z.infer<typeof Groups>;

export const groupsJsonSchema = strict({
  type: "object",
  properties: {
    groups: {
      type: "array",
      description:
        "Only groups of 2 or more candidates that are 1 thing to trade. Leave everything else out.",
      items: {
        type: "object",
        properties: {
          members: {
            type: "array",
            items: { type: "integer" },
            description: "Candidate numbers, as labeled",
          },
          reason: { type: "string", description: "1 short sentence" },
        },
        required: ["members", "reason"],
      },
    },
  },
  required: ["groups"],
} as const);

export const valueJsonSchema = strict({
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
} as const);

/** Whether a follow-up photo shows the same physical item as the hero. */
export const PhotoMatch = z.enum(["same_item", "other_item", "unclear"]);
export type PhotoMatch = z.infer<typeof PhotoMatch>;

export const SameItemResult = z.object({
  photos: z.array(PhotoMatch),
});

export const sameItemJsonSchema = strict({
  type: "object",
  properties: {
    photos: {
      type: "array",
      description: "1 answer per new photo, in order",
      items: { type: "string", enum: ["same_item", "other_item", "unclear"] },
    },
  },
  required: ["photos"],
} as const);
