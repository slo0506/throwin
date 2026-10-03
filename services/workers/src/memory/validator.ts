import {
  MAX_ACTIVE_TASTE_FACTS,
  MAX_TASTE_FACT_VALUE,
  TASTE_FACT_KEY,
  type TasteFactCategory,
} from "@throwin/shared";
import type { MemoryOperation } from "./schemas.js";

/** A taste fact as the extractor sees it. Deleted facts are kept so they are never rewritten. */
export interface ExistingFact {
  id: string;
  key: string;
  value: string;
  category: TasteFactCategory;
  alwaysOn: boolean;
  status: "active" | "superseded" | "deleted";
}

export type RejectReason =
  | "unknown_ref"
  | "bad_key"
  | "empty_value"
  | "too_long"
  | "sensitive"
  | "other_person"
  | "not_from_user"
  | "deleted_by_user"
  | "duplicate"
  | "no_change"
  | "cap_reached";

export type ValidWrite =
  | {
      op: "create";
      key: string;
      value: string;
      category: TasteFactCategory;
      alwaysOn: boolean;
      summary: string;
    }
  | {
      op: "update";
      fact: ExistingFact;
      key: string;
      value: string;
      category: TasteFactCategory;
      alwaysOn: boolean;
      summary: string;
    }
  | { op: "delete"; fact: ExistingFact; summary: string };

export interface Rejection {
  op: MemoryOperation["op"];
  key: string;
  reason: RejectReason;
  /** For sensitive rejections: which rule matched. Never the value itself. */
  detail?: string;
}

export interface ValidationContext {
  /** The user's facts in every status. */
  facts: ExistingFact[];
  /** Refs shown to the model (f1, f2, ...) and the facts they stand for. */
  refs: Map<string, ExistingFact>;
  /** First names of other people the user shares a Circle with. */
  otherNames: string[];
}

/** Always-on facts per user, at most. The rest are fetched when relevant. */
export const MAX_ALWAYS_ON = 12;

const words = (list: string[]) => new RegExp(`\\b(?:${list.join("|")})`, "i");

/**
 * Sensitive categories the extractor never stores, whatever the model proposes. Word
 * starts, so "pray" catches "praying". Deliberately broad: a missed trade fact costs less
 * than a stored diagnosis. Trade budgets ("cash ceiling", "budget") are not finances.
 * Words that are also product names people trade ("Doctor Strange", "Christian
 * Louboutin", "Chronicles of Narnia", LEGO "Hospital") are left out on purpose.
 */
const SENSITIVE: { name: string; pattern: RegExp }[] = [
  {
    name: "health",
    pattern: words([
      "health",
      "medical",
      "medicat",
      "medicine",
      "prescri",
      "diagnos",
      "disease",
      "illness",
      "cancer",
      "diabet",
      "asthma",
      "allerg",
      "adhd",
      "autis",
      "depress",
      "anxiety",
      "bipolar",
      "ptsd",
      "therap",
      "psychiatr",
      "mental",
      "disabilit",
      "disabled",
      "wheelchair",
      "pregnan",
      "surgery",
      "chemo",
      "hiv\\b",
      "rehab",
      "sober",
      "addict",
      "eating disorder",
      "insulin",
    ]),
  },
  {
    name: "religion",
    pattern: words([
      "religio",
      "church",
      "mosque",
      "synagogue",
      "pray",
      "bible",
      "quran",
      "koran",
      "torah",
      "christianity",
      "catholic",
      "muslim",
      "islam",
      "jewish",
      "judais",
      "hindu",
      "buddhis",
      "sikh",
      "mormon",
      "atheis",
      "sabbath",
      "ramadan",
      "kosher",
      "halal",
    ]),
  },
  {
    name: "politics",
    pattern: words([
      "politic",
      "democrat",
      "republican",
      "liberal\\b",
      "conservative\\b",
      "maga\\b",
      "trump",
      "biden",
      "election",
      "voted",
      "voting",
      "socialis",
      "communis",
      "left-wing",
      "right-wing",
      "activis",
    ]),
  },
  {
    name: "sexuality",
    pattern: words([
      "sexual",
      "gay\\b",
      "lesbian",
      "bisexual",
      "queer",
      "lgbt",
      "transgender",
      "nonbinary",
      "non-binary",
      "pronoun",
      "homosexual",
      "heterosexual",
      "asexual",
    ]),
  },
  {
    name: "ethnicity",
    pattern: words([
      "ethnic",
      "racial",
      "race\\b(?! car)",
      "racis",
      "hispanic",
      "latino",
      "latina",
      "latinx",
      "caucasian",
      "african american",
      "asian american",
      "native american",
      "immigra",
      "citizenship",
    ]),
  },
  {
    name: "finances",
    pattern: words([
      "salary",
      "income",
      "paycheck",
      "debt",
      "loan",
      "mortgage",
      "rent\\b",
      "savings",
      "net worth",
      "bank account",
      "credit score",
      "credit card",
      "bankrupt",
      "unemploy",
      "laid off",
      "lost my job",
      "can't afford",
      "cannot afford",
      "broke\\b",
      "welfare",
      "food stamps",
    ]),
  },
];

/** People words: a fact about any of them is about someone else. */
const OTHER_PERSON = words([
  "my (?:wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?|son|daughter|kids?|children|child|mom|mother|dad|father|parents?|brother|sister|sibling|cousin|aunt|uncle|grand\\w*|friend|roommate|boss|coworker|neighbor|ex)\\b",
  "(?:his|her|their) (?:shelf|items?|collection|ask)",
]);

/** The category of the first sensitive rule the text matches, or null. */
export function sensitiveCategory(text: string): string | null {
  for (const rule of SENSITIVE) if (rule.pattern.test(text)) return rule.name;
  return null;
}

/** True when the text is about someone other than the user. */
export function mentionsOtherPerson(text: string, otherNames: string[]): boolean {
  if (OTHER_PERSON.test(text)) return true;
  const lower = ` ${normalizeValue(text)} `;
  return otherNames.some((name) => {
    const n = normalizeValue(name);
    return n.length >= 2 && lower.includes(` ${n} `);
  });
}

/** For matching values: case, punctuation, spacing and a leading article do not count. */
export function normalizeValue(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|my|a|an) /, "");
}

const same = (a: { key: string; value: string }, b: { key: string; value: string }) =>
  a.key === b.key && normalizeValue(a.value) === normalizeValue(b.value);

/** Keys outside interests and limits that may still be always on. */
const ALWAYS_ON_KEYS = /(?:handoff|autonomy)/;

function alwaysOnAllowed(category: TasteFactCategory, key: string) {
  return category === "interests" || category === "limits" || ALWAYS_ON_KEYS.test(key);
}

/** En and em dashes, spelled as escapes so the source itself has none. */
export const DASHES = /\s*[\u2013\u2014]\s*/g;

/** No em or en dashes in UI copy, 1 line, at most 120 characters. */
export function plainLine(text: string, max = 120): string {
  const line = text.replace(DASHES, ", ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The Activity log line for a write, e.g. "Noted: you'd never trade the Millennium Falcon". */
export function summaryFor(
  op: MemoryOperation["op"],
  note: string,
  key: string,
  value: string,
  otherNames: string[],
): string {
  const verb = op === "delete" ? "Forgot" : op === "update" ? "Updated" : "Noted";
  const cleanNote = plainLine(note, 100);
  const safe =
    cleanNote.length > 0 &&
    sensitiveCategory(cleanNote) === null &&
    !mentionsOtherPerson(cleanNote, otherNames);
  const text = safe ? cleanNote : `${key.replace(/_/g, " ")}: ${plainLine(value, 80)}`;
  return plainLine(`${verb}: ${text}`);
}

/**
 * The write validator. Everything the model proposes passes through here before it touches
 * the database; rejections are logged as internal events, never shown to the user.
 */
export function validateOperations(
  ops: MemoryOperation[],
  ctx: ValidationContext,
): { writes: ValidWrite[]; rejections: Rejection[] } {
  const writes: ValidWrite[] = [];
  const rejections: Rejection[] = [];
  const active = ctx.facts.filter((f) => f.status === "active");
  const deleted = ctx.facts.filter((f) => f.status === "deleted");
  let activeCount = active.length;
  let alwaysOnCount = active.filter((f) => f.alwaysOn).length;
  /** Facts this batch already touched, so 2 ops cannot both update or delete 1 fact. */
  const touched = new Set<string>();
  /** Key and value pairs this batch writes, to catch duplicates within the batch. */
  const written: { key: string; value: string }[] = [];

  const reject = (op: MemoryOperation, reason: RejectReason, detail?: string) =>
    rejections.push({ op: op.op, key: op.key, reason, ...(detail && { detail }) });

  for (const op of ops) {
    const fact = op.ref === null ? undefined : ctx.refs.get(op.ref);
    if (op.op !== "create" && (fact?.status !== "active" || touched.has(fact.id))) {
      reject(op, "unknown_ref");
      continue;
    }
    if (op.evidence !== "user_said") {
      reject(op, "not_from_user");
      continue;
    }

    if (op.op === "delete") {
      const target = fact as ExistingFact;
      touched.add(target.id);
      if (target.alwaysOn) alwaysOnCount--;
      activeCount--;
      writes.push({
        op: "delete",
        fact: target,
        summary: summaryFor("delete", op.note, target.key, target.value, ctx.otherNames),
      });
      continue;
    }

    const key = op.key.trim();
    const value = op.value.replace(/\s+/g, " ").trim();
    if (!TASTE_FACT_KEY.test(key)) {
      reject(op, "bad_key");
      continue;
    }
    if (value.length === 0) {
      reject(op, "empty_value");
      continue;
    }
    if (value.length > MAX_TASTE_FACT_VALUE) {
      reject(op, "too_long");
      continue;
    }
    const sensitive = sensitiveCategory(`${key.replace(/_/g, " ")} ${value}`);
    if (sensitive) {
      reject(op, "sensitive", sensitive);
      continue;
    }
    if (op.about !== "user" || mentionsOtherPerson(value, ctx.otherNames)) {
      reject(op, "other_person");
      continue;
    }
    const candidate = { key, value };
    if (deleted.some((d) => same(d, candidate))) {
      reject(op, "deleted_by_user");
      continue;
    }
    const replaced = op.op === "update" ? (fact as ExistingFact) : undefined;
    if (replaced && same(replaced, candidate) && replaced.category === op.category) {
      reject(op, "no_change");
      continue;
    }
    if (
      active.some((f) => f.id !== replaced?.id && !touched.has(f.id) && same(f, candidate)) ||
      written.some((w) => same(w, candidate))
    ) {
      reject(op, "duplicate");
      continue;
    }
    if (!replaced && activeCount >= MAX_ACTIVE_TASTE_FACTS) {
      reject(op, "cap_reached");
      continue;
    }

    const alreadyOn = replaced?.alwaysOn ?? false;
    const alwaysOn =
      op.always_on &&
      alwaysOnAllowed(op.category, key) &&
      (alreadyOn || alwaysOnCount < MAX_ALWAYS_ON);
    if (alwaysOn !== alreadyOn) alwaysOnCount += alwaysOn ? 1 : -1;
    written.push(candidate);
    const summary = summaryFor(op.op, op.note, key, value, ctx.otherNames);
    if (replaced) {
      touched.add(replaced.id);
      writes.push({
        op: "update",
        fact: replaced,
        key,
        value,
        category: op.category,
        alwaysOn,
        summary,
      });
    } else {
      activeCount++;
      writes.push({ op: "create", key, value, category: op.category, alwaysOn, summary });
    }
  }
  return { writes, rejections };
}
