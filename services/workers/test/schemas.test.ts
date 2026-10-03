import { describe, expect, it } from "vitest";
import {
  Box,
  detectionJsonSchema,
  groupsJsonSchema,
  Identification,
  identificationJsonSchema,
  ValueEstimate,
  valueJsonSchema,
} from "../src/appraiser/schemas.js";

describe("schemas", () => {
  it("normalizes and clamps boxes", () => {
    expect(Box.parse([0.8, 1.2, -0.1, 0.3])).toEqual([0, 0.3, 0.8, 1]);
  });

  it("orders a value range low to high", () => {
    const v = ValueEstimate.parse({
      low_usd: 90,
      mid_usd: 70,
      high_usd: 100,
      basis: [],
      confidence: 0.5,
    });
    expect([v.low_usd, v.mid_usd, v.high_usd]).toEqual([70, 90, 100]);
  });
});

/** Structured outputs reject or ignore these, and force additionalProperties: false. */
function walk(node: unknown, path: string, problems: string[]) {
  if (Array.isArray(node)) {
    for (const [i, n] of node.entries()) walk(n, `${path}[${i}]`, problems);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (key in obj) problems.push(`${path}.${key}`);
  }
  if (obj.type === "object" && !obj.properties) problems.push(`${path}: free-form object`);
  if (obj.type === "object" && obj.additionalProperties !== false) {
    problems.push(`${path}: additionalProperties must be false`);
  }
  for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`, problems);
}

describe("structured output schemas", () => {
  it.each([
    ["detection", detectionJsonSchema],
    ["identification", identificationJsonSchema],
    ["value", valueJsonSchema],
    ["groups", groupsJsonSchema],
  ])("%s schema avoids unsupported keywords and free-form objects", (_, schema) => {
    const problems: string[] = [];
    walk(schema, "$", problems);
    expect(problems).toEqual([]);
  });

  it("turns attribute pairs into a map and tolerates a short age range", () => {
    const parsed = Identification.parse({
      is_tradeable_item: true,
      title: "Air Jordan 1 Mid",
      category: "sneakers",
      brand: "Nike",
      model: null,
      variant: null,
      attributes: [{ name: "size", value: "10" }],
      condition_grade: "C",
      defects: ["creasing"],
      age_estimate_years: [2],
      identity_confidence: 0.8,
      condition_confidence: 0.75,
      follow_up: null,
    });
    expect(parsed.attributes).toEqual({ size: "10" });
    expect(parsed.age_estimate_years).toBeNull();
  });
});

describe("Identification text", () => {
  const base = {
    is_tradeable_item: true,
    title: "Air Jordan 4",
    category: "sneakers",
    brand: "Nike",
    model: null,
    variant: null,
    attributes: [],
    condition_grade: "B",
    defects: [],
    age_estimate_years: null,
    identity_confidence: 0.6,
    condition_confidence: 0.6,
    follow_up: null,
  };

  it("trims overlong text instead of rejecting the Item", () => {
    const parsed = Identification.parse({ ...base, variant: "x".repeat(81) });
    expect(parsed.variant).toHaveLength(80);
    expect(parsed.variant?.endsWith("\u2026")).toBe(true);
  });

  it("drops a leaked JSON tail and empty strings", () => {
    const parsed = Identification.parse({
      ...base,
      follow_up: 'Photo of the size tag."}',
      model: "  ",
    });
    expect(parsed.follow_up).toBe("Photo of the size tag.");
    expect(parsed.model).toBeNull();
  });
});

describe("box_in_crop", () => {
  const base = {
    is_tradeable_item: true,
    title: "Hydro Flask 32 oz Wide Mouth",
    category: "accessories",
    brand: "Hydro Flask",
    model: null,
    variant: null,
    attributes: [],
    condition_grade: "B",
    defects: [],
    age_estimate_years: null,
    identity_confidence: 0.8,
    condition_confidence: 0.8,
    follow_up: null,
  };

  it("is required from the model, with additionalProperties false on each entry", () => {
    expect(identificationJsonSchema.required).toContain("box_in_crop");
    const entry = identificationJsonSchema.properties.box_in_crop.items as {
      additionalProperties?: boolean;
      required: readonly string[];
    };
    expect(entry.additionalProperties).toBe(false);
    expect(entry.required).toEqual(["crop", "box"]);
  });

  it("keeps good boxes in order and drops malformed ones instead of failing the Item", () => {
    const parsed = Identification.parse({
      ...base,
      box_in_crop: [
        { crop: 1, box: [0.7, 0.9, 0.4, 0.1] },
        { crop: 2, box: [0.1, 0.2, 0.3] },
        { crop: 1.5, box: [0, 0, 1, 1] },
        { crop: 2, box: [-0.2, 0.1, 0.5, 1.4] },
      ],
    });
    expect(parsed.box_in_crop).toEqual([
      { crop: 1, box: [0.4, 0.1, 0.7, 0.9] },
      { crop: 2, box: [0, 0.1, 0.5, 1] },
    ]);
  });

  it("is optional for stored and follow-up readings", () => {
    expect(Identification.parse(base).box_in_crop).toBeUndefined();
  });
});
