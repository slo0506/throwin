import { QuestionKind } from "@throwin/shared";
import { z } from "zod";
import { strict } from "../appraiser/schemas.js";

/** The judgment parts of a photo score, from 1 Haiku call. */
export const PhotoJudgment = z.object({
  item_visible: z.boolean(),
  whole_item_in_frame: z.boolean(),
  /** Share of the hero photo the item fills, 0 to 1. */
  fill: z.number().transform((v) => Math.min(1, Math.max(0, v))),
  background: z.enum(["clean", "some_clutter", "cluttered"]),
  angles_present: z.array(z.string()).transform((a) => [...new Set(a)].slice(0, 10)),
});
export type PhotoJudgment = z.infer<typeof PhotoJudgment>;

/** Built per call so angles_present can only name the category's own angles. */
export const photoJudgmentJsonSchema = (angles: readonly string[]) =>
  strict({
    type: "object",
    properties: {
      item_visible: {
        type: "boolean",
        description: "False when the named item is not clearly in the first photo",
      },
      whole_item_in_frame: {
        type: "boolean",
        description: "True when all of the item is inside the first photo with a little margin",
      },
      fill: {
        type: "number",
        description: "How much of the first photo the item fills, 0 to 1",
      },
      background: { type: "string", enum: ["clean", "some_clutter", "cluttered"] },
      angles_present: {
        type: "array",
        items: { type: "string", enum: [...angles] },
        description: "Which of the listed angles any photo clearly shows",
      },
    },
    required: ["item_visible", "whole_item_in_frame", "fill", "background", "angles_present"],
  });

const line = (max: number) =>
  z.string().transform((v) => {
    const t = v.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max).trimEnd() : t;
  });

/** Questions and a description from the identification (and research notes, if any). */
export const QuestionDraft = z.object({
  description: z.string().nullable(),
  questions: z
    .array(
      z.object({
        driver: line(60),
        kind: QuestionKind,
        prompt: line(200),
        options: z.array(line(60)),
        impact: z.number().transform((v) => Math.min(1, Math.max(0, v))),
      }),
    )
    .transform((q) => q.slice(0, 6)),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export const questionDraftJsonSchema = strict({
  type: "object",
  properties: {
    description: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "2 to 3 plain sentences about the item, or null when told not to write one",
    },
    questions: {
      type: "array",
      description: "At most the number of questions asked for, cheapest effort first",
      items: {
        type: "object",
        properties: {
          driver: { type: "string", description: "1 of the listed driver keys, exactly" },
          kind: { type: "string", enum: ["yes_no", "choice", "picker", "text", "photo"] },
          prompt: { type: "string", description: "The question, under 80 characters" },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "choice: 2 to 4 candidates (no Not sure, it is added). picker: the values. Otherwise empty.",
          },
          impact: {
            type: "number",
            description: "0 to 1: how much the answer would narrow the value range",
          },
        },
        required: ["driver", "kind", "prompt", "options", "impact"],
      },
    },
  },
  required: ["description", "questions"],
});

/** The Item after folding in the owner's answers. */
export const FoldedAnswers = z.object({
  title: line(120).pipe(z.string().min(1)),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  variant: z.string().nullable(),
  attributes: z
    .array(z.object({ name: line(60), value: line(200) }))
    .transform((pairs) => pairs.slice(0, 20)),
  identity_confidence: z.number().min(0).max(1),
  product_pinned: z.boolean(),
  description: z.string().nullable(),
});
export type FoldedAnswers = z.infer<typeof FoldedAnswers>;

export const foldedAnswersJsonSchema = strict({
  type: "object",
  properties: {
    title: { type: "string" },
    brand: { anyOf: [{ type: "string" }, { type: "null" }] },
    model: { anyOf: [{ type: "string" }, { type: "null" }] },
    variant: { anyOf: [{ type: "string" }, { type: "null" }] },
    attributes: {
      type: "array",
      description: "Only attributes to add or change, e.g. {name: 'size', value: '10'}",
      items: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
      },
    },
    identity_confidence: { type: "number", description: "0 to 1" },
    product_pinned: {
      type: "boolean",
      description:
        "True when the answers name the exact product (or the variant that drives value)",
    },
    description: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "2 to 3 plain sentences, or null when told not to write one",
    },
  },
  required: [
    "title",
    "brand",
    "model",
    "variant",
    "attributes",
    "identity_confidence",
    "product_pinned",
    "description",
  ],
});
