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

/** A snapshot case: constructed state and conversation, a new message, and expected outcome. */
export const EvalCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  suite: z.enum(EVAL_SUITES),
  description: z.string().min(1),
  state: z.record(z.string(), z.unknown()),
  conversation: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  message: z.string(),
  expect: z.record(z.string(), z.unknown()),
  /** For safety cases: the ID of the negative twin. */
  twin: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** Loads and validates every `*.json` case under a directory, recursively. */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const parsed = EvalCase.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.message}`);
    cases.push(parsed.data);
  }
  return cases;
}
