import type { PriceResult, Vision } from "./claude.js";
import type { Identification, ValueEstimate } from "./schemas.js";

/** A cached research result, stored in integer cents like every other money value. */
export interface CachedPrice {
  lowCents: number;
  midCents: number;
  highCents: number;
  confidence: number;
  basis: string[];
  research: string;
  model: string;
}

export interface PriceCacheStore {
  /** The entry for this key and grade written within the last maxAgeDays, if any. */
  getCachedPrice(
    key: string,
    grade: Identification["condition_grade"],
    maxAgeDays: number,
  ): Promise<CachedPrice | null>;
  /** Inserts or refreshes the entry for this key and grade. */
  putCachedPrice(
    key: string,
    grade: Identification["condition_grade"],
    price: CachedPrice,
  ): Promise<void>;
}

export interface PriceCacheConfig {
  /** 0 disables the cache. */
  ttlDays: number;
  /** Only estimates at least this confident are shared with later lookups. */
  minConfidence: number;
}

export const DEFAULT_PRICE_CACHE: PriceCacheConfig = { ttlDays: 7, minConfidence: 0.5 };

const norm = (v: string | null | undefined) =>
  (v ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The product, independent of whose it is: brand and model when the model is known (a set
 * number or SKU is the strongest key), otherwise the title. The variant is part of the key
 * because it moves value (a sneaker colorway, a game edition). Condition is keyed separately.
 */
export function productKey(id: Identification): string | null {
  const model = norm(id.model);
  const variant = norm(id.variant);
  const tail = variant ? `|${variant}` : "";
  if (model) return `m:${norm(id.brand)}|${model}${tail}`.slice(0, 300);
  const title = norm(id.title);
  // A bare category word ("headphones") is not a product; never share its price.
  if (title.split(" ").length < 2) return null;
  return `t:${title}${tail}`.slice(0, 300);
}

const toUsd = (cents: number) => cents / 100;
const toCents = (usd: number) => Math.round(usd * 100);

export function fromCache(hit: CachedPrice): PriceResult {
  const value: ValueEstimate = {
    low_usd: toUsd(hit.lowCents),
    mid_usd: toUsd(hit.midCents),
    high_usd: toUsd(hit.highCents),
    basis: hit.basis,
    confidence: hit.confidence,
  };
  return { value, research: hit.research, model: hit.model };
}

export function toCache(result: PriceResult): CachedPrice | null {
  if (!result.value) return null;
  return {
    lowCents: toCents(result.value.low_usd),
    midCents: toCents(result.value.mid_usd),
    highCents: toCents(result.value.high_usd),
    confidence: result.value.confidence,
    basis: result.value.basis,
    research: result.research.slice(0, 8000),
    model: result.model,
  };
}

/**
 * Prices through the shared cache. Concurrent lookups for the same key in this process
 * share 1 research call (2 copies of a game in 1 capture cost 1 research). Cache errors
 * never fail pricing: a broken cache just means paying for research.
 */
export class CachedPricer {
  readonly #inflight = new Map<string, Promise<PriceResult & { cached: boolean }>>();

  constructor(
    private readonly vision: Vision,
    private readonly store: PriceCacheStore,
    private readonly config: PriceCacheConfig = DEFAULT_PRICE_CACHE,
    private readonly onError: (op: string, err: unknown) => void = () => {},
  ) {}

  async price(id: Identification): Promise<PriceResult & { cached: boolean }> {
    const key = this.config.ttlDays > 0 ? productKey(id) : null;
    if (!key) return { ...(await this.vision.price(id)), cached: false };
    const slot = `${key}#${id.condition_grade}`;
    const pending = this.#inflight.get(slot);
    if (pending) return pending;
    const run = this.#price(key, id).finally(() => this.#inflight.delete(slot));
    this.#inflight.set(slot, run);
    return run;
  }

  async #price(key: string, id: Identification): Promise<PriceResult & { cached: boolean }> {
    try {
      const hit = await this.store.getCachedPrice(key, id.condition_grade, this.config.ttlDays);
      if (hit) return { ...fromCache(hit), cached: true };
    } catch (err) {
      this.onError("price_cache_read", err);
    }
    const result = await this.vision.price(id);
    const entry = toCache(result);
    if (entry && entry.confidence >= this.config.minConfidence) {
      try {
        await this.store.putCachedPrice(key, id.condition_grade, entry);
      } catch (err) {
        this.onError("price_cache_write", err);
      }
    }
    return { ...result, cached: false };
  }
}
