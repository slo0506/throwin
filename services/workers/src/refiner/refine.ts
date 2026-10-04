import {
  computeReadiness,
  type ItemReadiness,
  isNarrowRange,
  NOT_SURE,
  type PhotoIssue,
  type QuestionKind,
  type QuestionStatus,
  questionRank,
  YES_NO_OPTIONS,
} from "@throwin/shared";
import type { ModelRun, PriceResult } from "../appraiser/claude.js";
import { type PreparedImage, prepare } from "../appraiser/images.js";
import { changedMaterially, type PricedItem } from "../appraiser/pipeline.js";
import { type PriceCacheStore, productKey } from "../appraiser/price-cache.js";
import { looksPrivate } from "../appraiser/privacy.js";
import type { Identification } from "../appraiser/schemas.js";
import type { Logger } from "../log.js";
import { type CategorySpec, categoryOf, type Driver, unknownDrivers } from "./categories.js";
import type { AnsweredQuestion, RefinerModels } from "./models.js";
import { combine, DEFAULT_PHOTO_SCORE, measure, type PhotoScoreConfig } from "./photo-score.js";
import type { QuestionDraft } from "./schemas.js";
import { claimsAuthenticity, cleanDescription, plain } from "./text.js";

/** Why a pass runs: a new Item, an owner's answer, or new photos after reappraisal. */
export type RefineReason = "created" | "answer" | "photos";

export interface StoredQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  options: string[];
  driver: string;
  impact: number;
  status: QuestionStatus;
  skipCount: number;
  /** The owner's answer, or null for a skip or a photo answer. */
  answer: string | null;
  foldedAt: Date | null;
  createdAt: Date;
  answeredAt: Date | null;
}

/** An Item as the Refiner needs it. */
export interface RefineItem {
  id: string;
  userId: string;
  identification: Identification;
  identityConfirmed: boolean;
  /** Integer cents, or null before pricing. */
  value: { lowCents: number; midCents: number; highCents: number } | null;
  description: string | null;
  photoScore: number | null;
  missingAngles: string[];
  researchedAt: Date | null;
  /** Item photos in order; the first is the hero. */
  media: { id: string; path: string; position: number }[];
  questions: StoredQuestion[];
}

export interface NewQuestion {
  kind: QuestionKind;
  prompt: string;
  options: string[];
  driver: string;
  impact: number;
}

export interface RefinementUpdate {
  /** Present when answers changed the reading. */
  identification?: Identification;
  identityConfirmed?: boolean;
  /** Present when the Item was priced again. */
  priced?: PricedItem;
  description?: string;
  photo?: { score: number; issues: PhotoIssue[]; missingAngles: string[] };
  researchedAt?: Date;
  /** Answered or skipped questions this pass took into account. */
  foldedQuestionIds: string[];
  newQuestions: NewQuestion[];
  /** The Item reached identified: its open questions are no longer needed. */
  closeOpenQuestions: boolean;
  /** For logs and the appraisal history. */
  readiness: ItemReadiness;
}

/** Everything the Refiner reads and writes. Supabase in production, memory in tests. */
export interface RefinerStore extends PriceCacheStore {
  /** The user's Item with media and questions, or null when missing, removed or not theirs. */
  loadForRefine(itemId: string, userId: string): Promise<RefineItem | null>;
  download(path: string): Promise<Buffer>;
  /**
   * Writes the pass in place and clears appraising, unless answers given meanwhile are
   * still waiting to be folded (their own pass is queued).
   */
  saveRefinement(itemId: string, update: RefinementUpdate): Promise<void>;
  setAppraising(itemId: string, appraising: boolean): Promise<void>;
  recordRun(userId: string, run: ModelRun, trigger?: string): Promise<void>;
}

/** Refiner knobs (env: REFINER_*). */
export interface RefinerConfig {
  /** Open questions per Item at most. */
  maxOpenQuestions: number;
  /** SKU research with web search; false never researches. */
  research: boolean;
  /** Research only Items whose mid value is at least this. */
  researchMinMidCents: number;
  /** At most 1 research pass per Item in this window, unless the owner added information. */
  researchCooldownHours: number;
  /** A question skipped once may come back after this long. Twice means never. */
  reaskAfterHours: number;
  photo: PhotoScoreConfig;
}

export const DEFAULT_REFINER: RefinerConfig = {
  maxOpenQuestions: 3,
  research: true,
  researchMinMidCents: 4000,
  researchCooldownHours: 24,
  reaskAfterHours: 72,
  photo: DEFAULT_PHOTO_SCORE,
};

export interface RefinerDeps {
  store: RefinerStore;
  models: RefinerModels;
  /** Prices through the shared cache, like the Appraiser. */
  pricer: { price(id: Identification): Promise<PriceResult & { cached?: boolean }> };
  logger: Logger;
  config?: RefinerConfig;
  now?: () => Date;
}

export interface RefineOutcome {
  status: "refined" | "skipped";
  readiness?: ItemReadiness;
  photoScore?: number | null;
  questionsAdded?: number;
  folded?: number;
  repriced?: boolean;
  researched?: boolean;
}

const HOUR_MS = 3_600_000;
const MAX_PICKER_OPTIONS = 12;
const toCents = (usd: number) => Math.round(usd * 100);
const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** Whether answers changed something that moves value: the product, or a driver attribute. */
export function valueDriverChanged(
  before: Identification,
  after: Identification,
  spec: CategorySpec,
) {
  if (changedMaterially(before, after)) return true;
  const keys = new Set(spec.drivers.flatMap((d) => d.attributes.map((a) => a.toLowerCase())));
  const changed = (attrs: Record<string, string>, other: Record<string, string>) =>
    Object.entries(attrs).some(
      ([k, v]) => keys.has(k.toLowerCase().replace(/[^a-z0-9]+/g, "_")) && !sameText(v, other[k]),
    );
  return changed(after.attributes, before.attributes);
}

/**
 * "Is this the Classic Clog or the Bistro?": offers alternatives, so Yes and No don't answer
 * it. "Is it scratched or not?" still does.
 */
export function offersAlternatives(prompt: string): boolean {
  return /\bor\b(?!\s+not\b)/i.test(prompt);
}

/** Enforces the contract's option rules per kind. Null drops the question. */
export function normalizeQuestion(q: QuestionDraft["questions"][number]): NewQuestion | null {
  const prompt = plain(q.prompt);
  if (!prompt || claimsAuthenticity(prompt)) return null;
  let cleaned = [
    ...new Set(q.options.map(plain).filter((o) => o && o.toLowerCase() !== "not sure")),
  ];
  let kind = q.kind;
  // A yes/no prompt that offers alternatives becomes a choice when the model named them, and
  // is dropped otherwise: Yes or No would be an answer to nothing.
  if (kind === "yes_no" && offersAlternatives(prompt)) {
    const answers = cleaned.filter((o) => !["yes", "no"].includes(o.toLowerCase()));
    if (answers.length < 2) return null;
    kind = "choice";
    cleaned = answers;
  }
  let options: string[];
  switch (kind) {
    case "yes_no":
      options = [...YES_NO_OPTIONS];
      break;
    case "choice":
      if (cleaned.length < 2) return null;
      options = [...cleaned.slice(0, 4), NOT_SURE];
      break;
    case "picker":
      if (cleaned.length < 1) return null;
      options = cleaned.slice(0, MAX_PICKER_OPTIONS);
      break;
    default:
      options = [];
  }
  if (looksPrivate(prompt, ...options) || options.some(claimsAuthenticity)) return null;
  return {
    kind,
    prompt: prompt.slice(0, 200),
    options,
    driver: q.driver,
    impact: Math.round(q.impact * 100) / 100,
  };
}

/** Drivers that may get a new question: unknown, not open or answered, not skipped twice. */
export function askableDrivers(
  spec: CategorySpec,
  id: Identification,
  questions: StoredQuestion[],
  now: Date,
  reaskAfterHours: number,
): Driver[] {
  return unknownDrivers(spec, id).filter((driver) => {
    const rows = questions.filter((q) => q.driver === driver.key);
    if (rows.some((q) => q.status === "open" || q.status === "answered")) return false;
    const skips = rows.reduce((n, q) => n + q.skipCount, 0);
    if (skips >= 2) return false;
    const lastSkip = Math.max(0, ...rows.map((q) => q.answeredAt?.getTime() ?? 0));
    return skips === 0 || now.getTime() - lastSkip >= reaskAfterHours * HOUR_MS;
  });
}

async function fold(item: RefineItem, spec: CategorySpec, deps: RefinerDeps) {
  const pending = item.questions.filter((q) => q.status !== "open" && q.foldedAt === null);
  const answers: (AnsweredQuestion & { question: StoredQuestion })[] = pending.flatMap((q) =>
    q.status === "answered" && q.answer !== null && q.answer !== NOT_SURE
      ? [{ driver: q.driver, prompt: q.prompt, answer: q.answer, question: q }]
      : [],
  );
  const before = item.identification;
  if (answers.length === 0) {
    return {
      ids: pending.map((q) => q.id),
      identification: before,
      pinned: false,
      description: null,
    };
  }
  const folded = await deps.models.foldAnswers(
    before,
    answers.map(({ driver, prompt, answer }) => ({ driver, prompt, answer })),
    true,
  );
  const attributes = { ...before.attributes };
  for (const { name, value } of folded.attributes) {
    if (name && value && !looksPrivate(name, value)) attributes[name] = value;
  }
  const next: Identification = {
    ...before,
    title: folded.title,
    brand: folded.brand?.trim() || null,
    model: folded.model?.trim() || null,
    variant: folded.variant?.trim() || null,
    attributes,
    identity_confidence: folded.identity_confidence,
  };
  if (looksPrivate(next.title, next.brand, next.model)) {
    deps.logger.warn("refiner_fold_private", { item_id: item.id });
    return {
      ids: pending.map((q) => q.id),
      identification: before,
      pinned: false,
      description: null,
    };
  }
  // Pinning needs the owner to have spoken to identity: a picked candidate, or a brand,
  // model or edition question.
  const identityKeys = new Set(spec.drivers.filter((d) => d.identity).map((d) => d.key));
  const spokeToIdentity = answers.some(
    (a) => a.question.kind === "choice" || identityKeys.has(a.driver),
  );
  return {
    ids: pending.map((q) => q.id),
    identification: next,
    pinned: folded.product_pinned && spokeToIdentity,
    description: folded.description,
  };
}

async function scorePhoto(item: RefineItem, spec: CategorySpec, deps: RefinerDeps) {
  const ordered = [...item.media].sort((a, b) => a.position - b.position);
  const [heroRow, ...rest] = ordered;
  if (!heroRow) return null;
  // Newest extra photos first: they are the ones taken to show an angle.
  const extras = rest.slice(-4);
  const [hero, ...others] = await Promise.all(
    [heroRow, ...extras].map(async (m) => prepare(await deps.store.download(m.path))),
  );
  const metrics = await measure(hero as PreparedImage);
  const judgment = await deps.models.judgePhoto(
    hero as PreparedImage,
    others,
    item.identification.title,
    spec.angles,
  );
  const result = combine(metrics, judgment, spec.angles, deps.config?.photo);
  deps.logger.info("refiner_photo_scored", {
    item_id: item.id,
    score: result.score,
    issues: result.issues,
    long_edge: metrics.longEdge,
  });
  return result;
}

/**
 * 1 Refiner pass over an Item: fold in the owner's answers (re-pricing only when a value
 * driver changed), score the hero photo when it is new, write at most 3 cheap questions
 * for the value drivers still unknown (with SKU research only when it pays), write the
 * description when missing or when identity changed, then save it all with readiness.
 * Throws on failure so the job retries; the caller clears appraising after the last attempt.
 */
export async function refineItem(
  itemId: string,
  userId: string,
  reason: RefineReason,
  deps: RefinerDeps,
): Promise<RefineOutcome> {
  const { store, logger } = deps;
  const config = deps.config ?? DEFAULT_REFINER;
  const now = (deps.now ?? (() => new Date()))();
  const item = await store.loadForRefine(itemId, userId);
  if (!item) {
    logger.warn("refine_missing_item", { item_id: itemId });
    return { status: "skipped" };
  }

  // 1. Answers.
  const spec0 = categoryOf(item.identification);
  const folded = await fold(item, spec0, deps);
  const identification = folded.identification;
  const spec = categoryOf(identification);
  const identityChanged =
    productKey(item.identification) !== productKey(identification) ||
    !sameText(item.identification.brand, identification.brand);
  const identityConfirmed = item.identityConfirmed || folded.pinned;

  let priced: PricedItem | undefined;
  let value = item.value;
  if (
    identification !== item.identification &&
    (value === null || valueDriverChanged(item.identification, identification, spec))
  ) {
    try {
      const result = await deps.pricer.price(identification);
      priced = {
        identification,
        value: result.value,
        model: result.model,
        comps: {
          research: result.research,
          basis: result.value?.basis ?? [],
          cached: result.cached ?? false,
        },
      };
    } catch (err) {
      // Keep the old range rather than none: the answers refined, not replaced, the product.
      logger.error("refiner_price_failed", { item_id: itemId, error: String(err) });
    }
    if (priced?.value) {
      value = {
        lowCents: toCents(priced.value.low_usd),
        midCents: toCents(priced.value.mid_usd),
        highCents: toCents(priced.value.high_usd),
      };
    } else {
      priced = undefined;
    }
  }

  // 2. Photo score, when the photos are new to the Refiner.
  let photo: RefinementUpdate["photo"];
  if (reason !== "answer" || item.photoScore === null) {
    try {
      const scored = await scorePhoto(item, spec, deps);
      if (scored) {
        photo = { score: scored.score, issues: scored.issues, missingAngles: scored.missingAngles };
      }
    } catch (err) {
      logger.error("refiner_score_failed", { item_id: itemId, error: String(err) });
    }
  }

  const readiness = computeReadiness({
    identityConf: identification.identity_confidence,
    identityConfirmed,
    valueLowCents: value?.lowCents ?? null,
    valueHighCents: value?.highCents ?? null,
    photoScore: photo?.score ?? item.photoScore,
    missingAngles: photo?.missingAngles ?? item.missingAngles,
  });

  // 3. Questions and description.
  const foldedIds = new Set(folded.ids);
  const questions = item.questions.map((q) => (foldedIds.has(q.id) ? { ...q, foldedAt: now } : q));
  const open = questions.filter((q) => q.status === "open");
  const identified = readiness !== "logged";
  const slots = identified ? 0 : Math.max(0, config.maxOpenQuestions - open.length);
  const drivers =
    slots > 0 ? askableDrivers(spec, identification, questions, now, config.reaskAfterHours) : [];
  let description: string | null =
    folded.description && (identityChanged || !item.description)
      ? cleanDescription(folded.description)
      : null;
  const needDescription = !item.description && description === null;

  let research: string | null = null;
  let researchedAt: Date | undefined;
  const wide = value !== null && !isNarrowRange(value.lowCents, value.highCents);
  const recent =
    item.researchedAt !== null &&
    now.getTime() - item.researchedAt.getTime() < config.researchCooldownHours * HOUR_MS;
  if (
    config.research &&
    drivers.some((d) => d.identity) &&
    wide &&
    (value?.midCents ?? 0) >= config.researchMinMidCents &&
    (!recent || reason !== "created")
  ) {
    try {
      research = await deps.models.research(identification);
      researchedAt = now;
    } catch (err) {
      logger.error("refiner_research_failed", { item_id: itemId, error: String(err) });
    }
  }

  let newQuestions: NewQuestion[] = [];
  if (drivers.length > 0 || needDescription) {
    const draft = await deps.models.writeQuestions({
      identification,
      category: spec,
      drivers,
      count: Math.min(slots, drivers.length),
      writeDescription: needDescription,
      value: value ? { lowCents: value.lowCents, highCents: value.highCents } : null,
      photoHint: identification.follow_up,
      research,
    });
    const allowed = new Set(drivers.map((d) => d.key));
    const seen = new Set<string>();
    newQuestions = draft.questions
      .filter((q) => allowed.has(q.driver))
      .map(normalizeQuestion)
      .filter((q): q is NewQuestion => {
        if (!q || seen.has(q.driver)) return false;
        seen.add(q.driver);
        return true;
      })
      .sort((a, b) => questionRank(b) - questionRank(a))
      .slice(0, Math.min(slots, drivers.length));
    if (needDescription) description = cleanDescription(draft.description);
  }
  if (description && looksPrivate(description)) description = null;

  const update: RefinementUpdate = {
    ...(identification !== item.identification && { identification }),
    ...(identityConfirmed !== item.identityConfirmed && { identityConfirmed }),
    ...(priced && { priced }),
    ...(description && { description }),
    ...(photo && { photo }),
    ...(researchedAt && { researchedAt }),
    foldedQuestionIds: folded.ids,
    newQuestions,
    closeOpenQuestions: identified && open.length > 0,
    readiness,
  };
  await store.saveRefinement(itemId, update);
  const outcome: RefineOutcome = {
    status: "refined",
    readiness,
    photoScore: photo?.score ?? item.photoScore,
    questionsAdded: newQuestions.length,
    folded: folded.ids.length,
    repriced: priced !== undefined,
    researched: researchedAt !== undefined,
  };
  logger.info("refine_done", { item_id: itemId, reason, ...outcome });
  return outcome;
}
