/**
 * The Prospector, deterministic part (Milestone 3): turns 1 Ask into a want graph for each
 * of the asker's Circles and asks the matcher for Deals in live mode.
 *
 * 1. Embed every prospecting Ask in those Circles whose target changed (text-only query in
 *    the same Voyage space as Item photos).
 * 2. Pull want candidates from the database: for each Ask, the nearest Items other members
 *    offer for their own Asks.
 * 3. Score each candidate (embedding similarity, checked against brand, model and category)
 *    and keep the ones that clear the bar as explicit edges.
 * 4. Replace those Asks' stored edges and call the matcher anchored on the asker.
 *
 * 5. Review each Deal against every participant's taste facts (review.ts), dropping odd
 *    ones and writing each person's "why".
 * 6. Stage the kept Deals best first (public.stage_deal re-checks everything and holds the
 *    Items).
 *
 * The review is the only model call.
 */

import { createHash } from "node:crypto";
import { AskTarget } from "@throwin/shared";
import type { QueryEmbedder } from "../appraiser/embeddings.js";
import type { MatchDeal, Matcher, MatcherEdge } from "./matcher.js";
import {
  type ReviewFact,
  type ReviewItem,
  type ReviewModel,
  type ReviewParticipant,
  reviewDeal,
} from "./review.js";

export interface ProspectingAsk {
  id: string;
  userId: string;
  rawText: string;
  /** The stored target JSON; parsed leniently, since drafting Asks hold {}. */
  target: unknown;
  /** source_hash of the stored embedding for the current model, if any. */
  embeddingHash: string | null;
}

export interface WantCandidate {
  askId: string;
  wanterId: string;
  cashCeilingCents: number;
  itemId: string;
  giverId: string;
  giverAskId: string;
  similarity: number;
  title: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  valueMidCents: number;
}

export interface StoredEdge {
  fromUser: string;
  toUser: string;
  itemId: string;
  askId: string;
  giverAskId: string;
  utility: number;
  confidence: number;
}

export interface ProspectorStore {
  /** Null when missing or not the user's. */
  getAsk(userId: string, askId: string): Promise<{ status: string } | null>;
  circlesOf(userId: string): Promise<string[]>;
  prospectingAsks(circleIds: string[], model: string): Promise<ProspectingAsk[]>;
  saveAskEmbedding(askId: string, model: string, vector: number[], hash: string): Promise<void>;
  candidates(circleId: string, model: string, perAsk: number): Promise<WantCandidate[]>;
  /** Deletes the edges of these Asks and writes the new ones, in that order. */
  replaceEdges(askIds: string[], edges: StoredEdge[]): Promise<void>;
  /**
   * public.stage_deal: re-checks the Deal against the database, holds its Items and stores
   * each participant's why (keyed by user ID).
   */
  stageDeal(deal: MatchDeal, whys: Record<string, string>): Promise<StageResult>;
  /** What the review reads: participants' names and taste facts, and the Items' details. */
  reviewContext(userIds: string[], itemIds: string[]): Promise<ReviewContext>;
}

export interface ReviewContext {
  names: Map<string, string | null>;
  facts: Map<string, ReviewFact[]>;
  items: Map<string, ReviewItem>;
}

export type StageResult =
  | { result: "ok"; dealId: string }
  | { result: "dropped"; by: "never_trade" | "model"; reason: string }
  | {
      result: "invalid" | "ask_unavailable" | "offer_changed" | "over_ceiling" | "items_taken";
    };

export interface ProspectorConfig {
  /** Candidates below this embedding similarity are dropped unless the model number matches. */
  minSimilarity: number;
  candidatesPerAsk: number;
  /** Asks embedded per run at most, the asker's first, so 1 run stays inside its budget. */
  maxEmbedsPerRun: number;
  matcherTimeLimitSeconds: number;
}

export interface ProspectorDeps {
  store: ProspectorStore;
  embedder: QueryEmbedder;
  matcher: Matcher;
  review: ReviewModel;
  config: ProspectorConfig;
  logger: { info(event: string, data?: Record<string, unknown>): void };
}

export type ProspectOutcome =
  | { status: "skipped"; reason: "not_prospecting" | "no_circle" }
  | { status: "matched"; edges: number; embedded: number; deals: CircleDeal[] };

export interface CircleDeal {
  circleId: string;
  deal: MatchDeal;
  /**
   * What happened to it: dropped by the review, or what staging said. A staging refusal
   * means the database had moved on since matching.
   */
  staged: StageResult;
}

/** The text an Ask is embedded from: the resolved target when there is one. */
export function askEmbeddingText(ask: Pick<ProspectingAsk, "rawText" | "target">): string {
  const target = AskTarget.safeParse(ask.target);
  if (!target.success) return ask.rawText;
  const t = target.data;
  return [t.name, t.brand, t.model, t.category, ...t.constraints]
    .filter((part): part is string => Boolean(part))
    .join(". ");
}

export const embeddingHash = (model: string, text: string) =>
  createHash("sha256").update(`${model}\n${text}`).digest("hex");

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const topCategory = (c: string) => normalize(c.split("/")[0] ?? c);

/**
 * How well an Item fits an Ask, 0 to 1, or null when it doesn't fit. A matching model
 * number is strong evidence on its own; otherwise similarity must clear the bar, and an
 * exact Ask's brand and any Ask's top-level category must not contradict the Item.
 */
export function scoreCandidate(
  target: unknown,
  c: Pick<WantCandidate, "similarity" | "category" | "brand" | "model">,
  minSimilarity: number,
): number | null {
  const parsed = AskTarget.safeParse(target);
  const t = parsed.success ? parsed.data : null;
  if (t?.category && c.category && topCategory(t.category) !== topCategory(c.category)) {
    return null;
  }
  const brandClash = Boolean(t?.brand && c.brand && normalize(t.brand) !== normalize(c.brand));
  if (t?.kind === "exact" && brandClash) return null;
  if (t?.model && c.model && normalize(t.model) === normalize(c.model) && !brandClash) {
    return Math.max(0.95, c.similarity);
  }
  if (c.similarity < minSimilarity) return null;
  return Math.min(1, c.similarity);
}

/** Each person's side of a matched Deal, as the review reads it. */
export async function reviewParticipants(
  store: Pick<ProspectorStore, "reviewContext">,
  deal: MatchDeal,
): Promise<ReviewParticipant[]> {
  const ctx = await store.reviewContext(
    deal.users,
    deal.item_legs.map((l) => l.item_id),
  );
  const unknown: ReviewItem = {
    title: "an Item",
    category: null,
    conditionGrade: null,
    valueLowCents: null,
    valueHighCents: null,
  };
  const item = (id: string | undefined) => (id && ctx.items.get(id)) || unknown;
  const cash = (pick: (c: MatchDeal["cash_legs"][number]) => boolean) =>
    deal.cash_legs.filter(pick).reduce((sum, c) => sum + c.amount_cents, 0);
  return deal.users.map((userId) => ({
    userId,
    firstName: ctx.names.get(userId) ?? null,
    gives: item(deal.item_legs.find((l) => l.giver === userId)?.item_id),
    gets: item(deal.item_legs.find((l) => l.receiver === userId)?.item_id),
    paysCents: cash((c) => c.payer === userId),
    receivesCents: cash((c) => c.payee === userId),
    facts: ctx.facts.get(userId) ?? [],
  }));
}

export async function prospectAsk(
  askId: string,
  userId: string,
  deps: ProspectorDeps,
): Promise<ProspectOutcome> {
  const { store, embedder, matcher, config } = deps;
  const ask = await store.getAsk(userId, askId);
  if (ask?.status !== "prospecting") return { status: "skipped", reason: "not_prospecting" };
  const circleIds = await store.circlesOf(userId);
  if (circleIds.length === 0) return { status: "skipped", reason: "no_circle" };

  // 1. Embed Asks whose target changed, the asker's first.
  const asks = await store.prospectingAsks(circleIds, embedder.model);
  const stale = asks
    .map((a) => {
      const text = askEmbeddingText(a);
      return { ask: a, text, hash: embeddingHash(embedder.model, text) };
    })
    .filter((s) => s.ask.embeddingHash !== s.hash)
    .sort((a, b) => Number(b.ask.id === askId) - Number(a.ask.id === askId))
    .slice(0, config.maxEmbedsPerRun);
  for (const s of stale) {
    const vector = await embedder.embedQuery(s.text);
    await store.saveAskEmbedding(s.ask.id, embedder.model, vector, s.hash);
  }

  // 2 and 3. Score candidates into edges, per Circle.
  const targets = new Map(asks.map((a) => [a.id, a.target]));
  const edgesByCircle = new Map<string, MatcherEdge[]>();
  const stored = new Map<string, StoredEdge>();
  for (const circleId of circleIds) {
    const edges: MatcherEdge[] = [];
    for (const c of await store.candidates(circleId, embedder.model, config.candidatesPerAsk)) {
      const score = scoreCandidate(targets.get(c.askId), c, config.minSimilarity);
      if (score === null) continue;
      edges.push({
        from_user: c.wanterId,
        to_user: c.giverId,
        item_id: c.itemId,
        utility: score,
        confidence: score,
        kind: "explicit",
        ask_id: c.askId,
        giver_ask_id: c.giverAskId,
        value_cents: c.valueMidCents,
        cash_ceiling_cents: c.cashCeilingCents,
      });
      stored.set(`${c.askId}|${c.itemId}|${c.giverAskId}`, {
        fromUser: c.wanterId,
        toUser: c.giverId,
        itemId: c.itemId,
        askId: c.askId,
        giverAskId: c.giverAskId,
        utility: score,
        confidence: score,
      });
    }
    edgesByCircle.set(circleId, edges);
  }

  // 4. Store the graph, then match in live mode.
  await store.replaceEdges(
    asks.map((a) => a.id),
    [...stored.values()],
  );
  const matched: Omit<CircleDeal, "staged">[] = [];
  for (const [circleId, edges] of edgesByCircle) {
    if (!edges.some((e) => e.from_user === userId)) continue;
    const result = await matcher.match({
      edges,
      anchor_user: userId,
      time_limit_seconds: config.matcherTimeLimitSeconds,
    });
    matched.push(...result.deals.map((deal) => ({ circleId, deal })));
  }
  matched.sort((a, b) => b.deal.score - a.deal.score);

  // 5 and 6. Review, then stage, best first. A later Deal that shares an Ask or Item with an
  //    earlier one is refused by the database, which is what we want.
  const deals: CircleDeal[] = [];
  for (const m of matched) {
    const participants = await reviewParticipants(store, m.deal);
    const verdict = await reviewDeal(participants, deps.review);
    if (!verdict.keep) {
      deals.push({ ...m, staged: { result: "dropped", by: verdict.by, reason: verdict.reason } });
      continue;
    }
    deals.push({ ...m, staged: await store.stageDeal(m.deal, Object.fromEntries(verdict.whys)) });
  }
  deps.logger.info("prospect_matched", {
    ask_id: askId,
    circles: circleIds.length,
    asks: asks.length,
    embedded: stale.length,
    edges: stored.size,
    deals: deals.length,
    staged: deals.filter((d) => d.staged.result === "ok").length,
    dropped: deals.filter((d) => d.staged.result === "dropped").length,
  });
  return { status: "matched", edges: stored.size, embedded: stale.length, deals };
}
