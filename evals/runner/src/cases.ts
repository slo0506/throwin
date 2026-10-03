import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const EVAL_SUITES = [
  "intake",
  "ask_resolution",
  "appraisal",
  "grounding",
  "deal_explanation",
  "safety",
  "matcher",
] as const;

const caseId = z.string().regex(/^[a-z0-9-]+$/);

/**
 * Version 1, a snapshot case: constructed state and conversation, a new message, and the
 * expected outcome. Has no `version` field.
 */
export const SnapshotCase = z.object({
  id: caseId,
  suite: z.enum(EVAL_SUITES),
  description: z.string().min(1),
  state: z.record(z.string(), z.unknown()),
  conversation: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  message: z.string(),
  expect: z.record(z.string(), z.unknown()),
  /** For safety cases: the ID of the negative twin. */
  twin: z.string().optional(),
});
export type SnapshotCase = z.infer<typeof SnapshotCase>;

const cents = z.number().int().nonnegative();

/** 1 hand-labeled Item: what a careful person would list for this thing, and its honest range. */
export const LabeledItem = z
  .object({
    title: z.string().min(1),
    /** Other names the Appraiser might fairly use, e.g. "Switch Pro Controller". */
    aliases: z.array(z.string().min(1)).default([]),
    category: z.string().min(1),
    brand: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    condition_grade: z.enum(["A", "B", "C", "D"]),
    value_cents_low: cents,
    value_cents_high: cents,
    /** True when a good Appraiser should ask for 1 more photo (size tag, serial, and so on). */
    should_ask_for_photo: z.boolean().default(false),
    /** Label assist writes false. A human flips it to true after checking every field. */
    reviewed: z.boolean(),
    notes: z.string().optional(),
  })
  .strict()
  .refine((i) => i.value_cents_low <= i.value_cents_high, {
    message: "value_cents_low must be at most value_cents_high",
    path: ["value_cents_low"],
  });
export type LabeledItem = z.infer<typeof LabeledItem>;

/**
 * Version 2, a capture case: the photos or video a user would film, and the Items a
 * careful person would list from it. Media paths are relative to the media root
 * (`--media`, usually the gitignored `evals/media/`). An entry can be a file or a folder;
 * a folder means every image and video inside it, sorted by name.
 */
export const CaptureCase = z
  .object({
    version: z.literal(2),
    id: caseId,
    suite: z.literal("appraisal"),
    description: z.string().min(1),
    media: z.array(z.string().min(1)).min(1),
    items: z.array(LabeledItem),
    /** Things in frame that must never become Items, e.g. "prescription bottle", "AC remote". */
    forbidden: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CaptureCase = z.infer<typeof CaptureCase>;

export const EvalCase = z.union([CaptureCase, SnapshotCase]);
export type EvalCase = z.infer<typeof EvalCase>;

export const isCaptureCase = (c: EvalCase): c is CaptureCase => "version" in c && c.version === 2;

/** Picks the schema by `version` so errors describe the shape the author meant. */
export function parseCase(raw: unknown) {
  const versioned =
    typeof raw === "object" && raw !== null && "version" in raw && raw.version !== undefined;
  return versioned ? CaptureCase.safeParse(raw) : SnapshotCase.safeParse(raw);
}

/** Loads and validates every `*.json` case under a directory, recursively. */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
  const cases: EvalCase[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = parseCase(raw);
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.message}`);
    if (ids.has(parsed.data.id)) throw new Error(`${file}: duplicate case id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}

/** Labels a human has not checked yet, as `case id: title` lines. */
export function unreviewedLabels(cases: CaptureCase[]) {
  return cases.flatMap((c) => c.items.filter((i) => !i.reviewed).map((i) => `${c.id}: ${i.title}`));
}
