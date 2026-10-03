import { MATCH_THRESHOLD } from "./match.js";
import type { Summary } from "./score.js";

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (cents: number | null) => (cents === null ? "n/a" : `$${(cents / 100).toFixed(3)}`);
const money = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
const range = (r: [number, number] | null) => (r ? `${money(r[0])} to ${money(r[1])}` : "none");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface ReportMeta {
  casesDir: string;
  trials: number;
  skipped: string[];
  embedder: string;
  startedAt: string;
}

/** The markdown report: gates first, then the numbers, then every capture in detail. */
export function renderReport(summary: Summary, meta: ReportMeta) {
  const lines: string[] = [];
  lines.push("# Appraisal eval", "");
  lines.push(
    `${meta.startedAt}. ${plural(summary.cases.length, "capture")} from \`${meta.casesDir}\`, ${plural(meta.trials, "trial")} each, embeddings: ${meta.embedder}. Item counts below are summed over all trials.`,
    "",
  );
  lines.push(`**Result:** ${summary.pass ? "PASS" : "FAIL"}`, "");

  lines.push("## Gates", "", "| Gate | Target | Actual | |", "| --- | --- | --- | --- |");
  for (const g of summary.gates) {
    lines.push(`| ${g.name} | ${g.target} | ${g.actual} | ${g.pass ? "pass" : "FAIL"} |`);
  }
  lines.push("");

  lines.push("## Totals", "", "| Metric | Value |", "| --- | --- |");
  const rows: [string, string][] = [
    ["Capture trials", `${summary.trials}`],
    ["Labeled Items, all trials", `${summary.labeled}`],
    ["Predicted Items, all trials", `${summary.predicted}`],
    [
      "Correct (matched, range overlaps)",
      `${summary.correct} (${pct(summary.correctRate)} of labeled)`,
    ],
    ["Precision (matched of predicted)", pct(summary.precision)],
    ["Recall (matched of labeled)", pct(summary.recall)],
    ["Range overlap (correct of matched)", pct(summary.rangeOverlapRate)],
    ["Condition grade agreement", pct(summary.conditionAgreement)],
    ["Follow-up photo agreement", pct(summary.followUpAgreement)],
    ["Forbidden hits", `${summary.forbiddenHits}`],
    ["Errors", `${summary.errors}`],
    ["Latency, median", secs(summary.latencyMedianMs)],
    ["Latency, p90", secs(summary.latencyP90Ms)],
    ["Cost, total", usd(summary.costCents)],
    ["Cost per capture", usd(summary.costPerCaptureCents)],
    ["Cost per Item", usd(summary.costPerItemCents)],
  ];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  lines.push("");

  lines.push(
    "## Captures",
    "",
    "| Capture | Trials passed | Correct | Missed | Extra | Forbidden | Latency | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const c of summary.cases) {
    for (const t of c.trials) {
      lines.push(
        `| ${c.caseId} #${t.trial} | ${t.trial === 1 ? `${c.passedTrials} of ${c.trials.length}${c.pass ? "" : " FAIL"}` : ""} | ${t.correct} of ${t.labeled} | ${t.missed.length} | ${t.extra.length} | ${t.forbiddenHits.length} | ${secs(t.latencyMs)} | ${usd(t.costCents)} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Details", "");
  for (const c of summary.cases) {
    for (const t of c.trials) {
      lines.push(`### ${c.caseId}, trial ${t.trial}${t.pass ? "" : " (fails the M1 bar)"}`, "");
      if (t.error) lines.push(`**Error:** ${cell(t.error)}`, "");
      if (t.pairs.length > 0) {
        lines.push(
          "| Label | Predicted | Score | Labeled range | Predicted range | Range | Grade | Follow-up |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
        );
        for (const p of t.pairs) {
          lines.push(
            `| ${cell(p.label)} | ${cell(p.predicted)} | ${p.score.toFixed(2)} | ${range(p.labelRange)} | ${range(p.predictedRange)} | ${p.rangeOverlaps ? "overlaps" : "MISS"} | ${p.conditionAgrees ? "same" : "differs"} | ${p.followUpAgrees ? "same" : "differs"} |`,
          );
        }
        lines.push("");
      }
      if (t.missed.length) lines.push(`**Missed:** ${t.missed.map(cell).join("; ")}`, "");
      if (t.extra.length) lines.push(`**Extra:** ${t.extra.map(cell).join("; ")}`, "");
      for (const f of t.forbiddenHits) {
        lines.push(`**Forbidden:** "${cell(f.predicted)}" matched "${cell(f.phrase)}"`, "");
      }
    }
  }

  if (meta.skipped.length) {
    lines.push("## Skipped", "", "Version 1 snapshot cases, which this runner does not score:", "");
    for (const id of meta.skipped) lines.push(`- ${id}`);
    lines.push("");
  }

  lines.push(
    "## How this is scored",
    "",
    `- **Matching:** Each prediction is paired with at most 1 label, greedily by score. Score is the Dice overlap of normalized words in title, brand and model (best over the label's title and aliases). Pairs under ${MATCH_THRESHOLD} never match. Different model numbers never match; the same model number scores at least 0.75. Category only breaks ties.`,
    "- **Correct:** Matched, and the predicted value range overlaps the labeled range.",
    "- **M1 bar per trial:** Correct for at least 80% of labeled Items, under 60 s, no error. A capture passes when more than half of its trials do.",
    "- **Forbidden:** An unmatched prediction containing every word of a forbidden phrase.",
    "",
  );
  return lines.join("\n");
}
