import { describe, expect, it } from "vitest";
import { Box, ValueEstimate } from "../src/appraiser/schemas.js";

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

import {
  detectionJsonSchema,
  Identification,
  identificationJsonSchema,
  valueJsonSchema,
} from "../src/appraiser/schemas.js";

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
