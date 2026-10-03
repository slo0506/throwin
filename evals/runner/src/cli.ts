import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicModelClient } from "@throwin/harness";
import {
  createClaudeVision,
  createLogger,
  type Embedder,
  VoyageEmbedder,
} from "@throwin/workers/eval";
import { noopEmbedder, runCapture } from "./appraise.js";
import {
  type CaptureCase,
  isCaptureCase,
  loadCases,
  type SnapshotCase,
  unreviewedLabels,
} from "./cases.js";
import { loadCaptureFrames } from "./frames.js";
import { isGmCase, runGmCase } from "./gm.js";
import { draftCase, slug } from "./label.js";
import { plural, renderReport } from "./report.js";
import { scoreTrial, summarize, type TrialScore } from "./score.js";

const USAGE = `Usage:
  eval:appraisal --cases <dir> --media <dir> [--trials 3] [--out report.md] [--case <id>] [--allow-unreviewed]
  eval:label --media <capture dir or file> --out <case.json> [--root <media root>] [--force]
  eval:gm [--cases evals/cases] [--suite safety] [--case <id>] [--trials 3]

Needs ANTHROPIC_API_KEY. Uses VOYAGE_API_KEY for embeddings when set.`;

class UsageError extends Error {}

/** pnpm runs scripts in the package folder; resolve paths from where the user typed. */
const base = process.env.INIT_CWD ?? process.cwd();
const fromUser = (p: string) => resolve(base, p);
const log = (msg: string) => process.stderr.write(`${msg}\n`);
/** A path relative to where the user typed when it is under it, else absolute. */
const shown = (p: string) => {
  const rel = relative(base, p);
  return rel && !rel.startsWith("..") ? rel : p;
};

function env() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new UsageError("ANTHROPIC_API_KEY is not set");
  const voyageKey = process.env.VOYAGE_API_KEY;
  const embedder: Embedder = voyageKey ? new VoyageEmbedder(voyageKey) : noopEmbedder;
  const logger = createLogger(process.env.LOG_LEVEL === "debug" ? "debug" : "warn");
  return { anthropicKey, embedder, logger };
}

async function appraisal(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: "string" },
      media: { type: "string" },
      trials: { type: "string", default: "1" },
      out: { type: "string" },
      case: { type: "string" },
      "allow-unreviewed": { type: "boolean", default: false },
    },
  });
  if (!values.cases || !values.media) throw new UsageError("--cases and --media are required");
  const trials = Number.parseInt(values.trials, 10);
  if (!Number.isInteger(trials) || trials < 1) throw new UsageError("--trials must be 1 or more");
  const casesDir = fromUser(values.cases);
  const mediaRoot = fromUser(values.media);

  const all = await loadCases(casesDir);
  const skipped = all.filter((c) => !isCaptureCase(c)).map((c) => c.id);
  let captures = all.filter(isCaptureCase) as CaptureCase[];
  if (values.case) captures = captures.filter((c) => c.id.includes(values.case as string));
  if (captures.length === 0) throw new UsageError(`no capture cases (version 2) in ${casesDir}`);

  const unreviewed = unreviewedLabels(captures);
  if (unreviewed.length > 0 && !values["allow-unreviewed"]) {
    throw new UsageError(
      `${unreviewed.length} labels are not reviewed yet. Review them and set "reviewed": true, or pass --allow-unreviewed:\n  ${unreviewed.join("\n  ")}`,
    );
  }

  const { anthropicKey, embedder, logger } = env();
  const startedAt = new Date().toISOString();
  const scores: TrialScore[] = [];
  for (const c of captures) {
    const frames = await loadCaptureFrames(mediaRoot, c.media);
    log(`${c.id}: ${plural(frames.length, "frame")}, ${plural(c.items.length, "labeled Item")}`);
    for (let trial = 1; trial <= trials; trial++) {
      const result = await runCapture(`${c.id}-${trial}`, frames, {
        makeVision: (onRun) => createClaudeVision(anthropicKey, onRun),
        embedder,
        logger,
      });
      const score = scoreTrial(c, {
        caseId: c.id,
        trial,
        predicted: result.predicted,
        latencyMs: result.latencyMs,
        firstItemMs: result.firstItemMs,
        costCents: result.runs.reduce((a, r) => a + r.costCents, 0),
        modelRuns: result.runs.length,
        error: result.error,
      });
      scores.push(score);
      log(
        `  trial ${trial}: ${score.correct} of ${score.labeled} correct, ${score.extra.length} extra, ${score.forbiddenHits.length} forbidden, ${(score.latencyMs / 1000).toFixed(1)} s${score.error ? `, error: ${score.error}` : ""}`,
      );
    }
  }

  const summary = summarize(scores);
  const report = renderReport(summary, {
    casesDir: shown(casesDir),
    trials,
    skipped,
    embedder: embedder.model,
    startedAt,
  });
  if (values.out) {
    const out = fromUser(values.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, report);
    log(`Report: ${out}`);
  } else {
    process.stdout.write(report);
  }
  for (const g of summary.gates) log(`${g.pass ? "pass" : "FAIL"}  ${g.name}: ${g.actual}`);
  return summary.pass ? 0 : 1;
}

async function label(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      media: { type: "string" },
      out: { type: "string" },
      root: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  if (!values.media || !values.out) throw new UsageError("--media and --out are required");
  const media = fromUser(values.media);
  const root = values.root ? fromUser(values.root) : dirname(media);
  const entry = relative(root, media);
  if (!entry || entry.startsWith("..")) throw new UsageError("--media must be inside --root");
  const out = fromUser(values.out);
  if (!values.force && (await stat(out).catch(() => null))) {
    throw new UsageError(`${out} exists. Pass --force to overwrite it.`);
  }

  const { anthropicKey, embedder, logger } = env();
  const frames = await loadCaptureFrames(root, [entry]);
  log(`${entry}: ${plural(frames.length, "frame")}`);
  const id = slug(entry);
  const result = await runCapture(id, frames, {
    makeVision: (onRun) => createClaudeVision(anthropicKey, onRun),
    embedder,
    logger,
  });
  if (result.error) throw new Error(`Appraiser failed: ${result.error}`);
  const draft = draftCase(id, [entry], result.predicted);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(draft, null, 2)}\n`);
  log(
    `Wrote ${plural(draft.items.length, "draft label")} to ${out} in ${(result.latencyMs / 1000).toFixed(1)} s. Review each one and set "reviewed": true. Media paths are relative to ${root}.`,
  );
  return 0;
}

async function gm(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: "string", default: "evals/cases" },
      trials: { type: "string", default: "1" },
      case: { type: "string" },
      suite: { type: "string" },
    },
  });
  const trials = Number.parseInt(values.trials, 10);
  if (!Number.isInteger(trials) || trials < 1) throw new UsageError("--trials must be 1 or more");
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new UsageError("ANTHROPIC_API_KEY is not set");

  let cases = (await loadCases(fromUser(values.cases)))
    .filter((c): c is SnapshotCase => !isCaptureCase(c))
    .filter(isGmCase);
  if (values.suite) cases = cases.filter((c) => c.suite === values.suite);
  if (values.case) cases = cases.filter((c) => c.id.includes(values.case as string));
  if (cases.length === 0) throw new UsageError("no GM cases matched");

  const model = AnthropicModelClient.fromApiKey(anthropicKey);
  let failed = 0;
  let cost = 0;
  for (const c of cases) {
    let passes = 0;
    for (let trial = 1; trial <= trials; trial++) {
      const result = await runGmCase(c, model);
      cost += result.costCents;
      if (result.pass) passes++;
      else
        log(
          `  ${c.id} trial ${trial}: ${result.failures.join("; ")}\n    text: ${result.text.slice(0, 300)}`,
        );
    }
    // A case passes when it passes in more than half of its trials.
    const pass = passes * 2 > trials;
    if (!pass) failed++;
    log(`${pass ? "pass" : "FAIL"}  ${c.suite}/${c.id}: ${passes} of ${trials}`);
  }
  log(`${cases.length - failed} of ${cases.length} cases passed, ${cost.toFixed(2)} cents`);
  return failed === 0 ? 0 : 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "appraisal") return await appraisal(rest);
    if (command === "gm") return await gm(rest);
    if (command === "label") return await label(rest);
    throw new UsageError(`unknown command: ${command ?? "(none)"}`);
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err)) {
      log(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    log(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 2;
  }
}

process.exitCode = await main();
