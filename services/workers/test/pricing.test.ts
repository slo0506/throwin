import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeVision, DEFAULT_PRICING, MODELS, type ModelRun } from "../src/appraiser/claude.js";
import { CachedPricer, productKey } from "../src/appraiser/price-cache.js";
import { looksPrivate } from "../src/appraiser/privacy.js";
import { loadEnv } from "../src/env.js";
import { fakeVision, identification, MemoryStore, priceResult } from "./support.js";

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** A fake Messages API: research turns return notes, extraction returns the next value. */
function fakeClient(confidenceByModel: Record<string, number>) {
  const calls: CreateParams[] = [];
  const client = {
    messages: {
      async create(params: CreateParams) {
        calls.push(params);
        const extracting = "output_config" in params && params.output_config !== undefined;
        const notes = JSON.stringify(params.messages);
        const researchedBy = Object.keys(confidenceByModel).find((m) => notes.includes(`by ${m}`));
        const text = extracting
          ? JSON.stringify({
              low_usd: 100,
              mid_usd: 120,
              high_usd: 140,
              basis: ["eBay sold $120"],
              confidence: confidenceByModel[researchedBy ?? ""] ?? 0.1,
            })
          : `Comps found by ${params.model}.`;
        return {
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: extracting ? 1000 : 9000,
            output_tokens: 200,
            server_tool_use: extracting ? undefined : { web_search_requests: 1 },
          },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const research = (calls: CreateParams[]) => calls.filter((c) => !("output_config" in c));

describe("ClaudeVision.price", () => {
  it("researches with Haiku, basic search, capped searches and tokens", async () => {
    const { client, calls } = fakeClient({ [MODELS.fast]: 0.8 });
    const runs: ModelRun[] = [];
    const vision = new ClaudeVision(client, (r) => runs.push(r));
    const result = await vision.price(identification());

    expect(result.model).toBe(MODELS.fast);
    expect(result.value?.mid_usd).toBe(120);
    const [turn] = research(calls);
    expect(turn?.model).toBe(MODELS.fast);
    expect(turn?.max_tokens).toBe(DEFAULT_PRICING.researchMaxTokens);
    expect(turn?.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: DEFAULT_PRICING.maxSearches },
    ]);
    // 9000 input and 200 output Haiku tokens plus 1 search: 0.9 + 0.1 + 1 cents.
    const run = runs.find((r) => r.agent === "appraiser.price.research");
    expect(run?.costCents).toBeCloseTo(2, 5);
  });

  it("falls back to Sonnet with dynamic filtering when Haiku's estimate is weak", async () => {
    const { client, calls } = fakeClient({ [MODELS.fast]: 0.2, [MODELS.smart]: 0.7 });
    const vision = new ClaudeVision(client);
    const result = await vision.price(identification());
    expect(result.model).toBe(MODELS.smart);
    expect(research(calls).map((c) => c.model)).toEqual([MODELS.fast, MODELS.smart]);
    expect(research(calls)[1]?.tools?.[0]).toMatchObject({ type: "web_search_20260318" });
  });

  it("keeps Haiku's estimate when the fallback is no better, and skips it when disabled", async () => {
    const weak = fakeClient({ [MODELS.fast]: 0.3, [MODELS.smart]: 0.2 });
    expect((await new ClaudeVision(weak.client).price(identification())).model).toBe(MODELS.fast);

    const off = fakeClient({ [MODELS.fast]: 0.1 });
    const vision = new ClaudeVision(off.client, () => {}, {
      ...DEFAULT_PRICING,
      fallbackModel: null,
    });
    await vision.price(identification());
    expect(research(off.calls)).toHaveLength(1);
  });
});

describe("CachedPricer", () => {
  it("reads before researching and writes only confident estimates", async () => {
    const store = new MemoryStore();
    const vision = fakeVision({ objects: [] }, []);
    const pricer = new CachedPricer(vision, store);
    const lego = identification();

    vision.priceImpl = async () => priceResult(165, 0.3);
    expect((await pricer.price(lego)).cached).toBe(false);
    expect(store.cache.size).toBe(0);

    vision.priceImpl = async () => priceResult(165, 0.8);
    await pricer.price(lego);
    const hit = await pricer.price({ ...lego, title: "LEGO Typewriter (2021)" });
    expect(hit.cached).toBe(true);
    expect(hit.value).toMatchObject({ low_usd: 140, mid_usd: 165, high_usd: 190 });
    expect(vision.priceCalls).toBe(2);

    // Another grade is another price.
    await pricer.price({ ...lego, condition_grade: "D" });
    expect(vision.priceCalls).toBe(3);
  });

  it("stores money as integer cents", async () => {
    const store = new MemoryStore();
    const vision = fakeVision({ objects: [] }, []);
    vision.priceImpl = async () => ({
      ...priceResult(),
      value: { low_usd: 9.99, mid_usd: 12.5, high_usd: 15.333, basis: [], confidence: 0.9 },
    });
    await new CachedPricer(vision, store).price(identification());
    const [entry] = [...store.cache.values()];
    expect([entry?.lowCents, entry?.midCents, entry?.highCents]).toEqual([999, 1250, 1533]);
  });

  it("keeps pricing when the cache is down, and can be turned off", async () => {
    const store = new MemoryStore();
    store.getCachedPrice = async () => {
      throw new Error("db down");
    };
    const errors: string[] = [];
    const vision = fakeVision({ objects: [] }, []);
    const pricer = new CachedPricer(vision, store, undefined, (op) => errors.push(op));
    expect((await pricer.price(identification())).value).not.toBeNull();
    expect(errors).toEqual(["price_cache_read"]);

    const off = new CachedPricer(vision, new MemoryStore(), { ttlDays: 0, minConfidence: 0.5 });
    await off.price(identification());
    await off.price(identification());
    expect(vision.priceCalls).toBe(3);
  });
});

describe("productKey", () => {
  it("normalizes brand, model and variant, and refuses bare category words", () => {
    expect(productKey(identification({ brand: "LEGO®", model: " 21327 " }))).toBe("m:lego|21327");
    expect(
      productKey(
        identification({ brand: "Nike", model: "DZ5485-612", variant: "Chicago Lost & Found" }),
      ),
    ).toBe("m:nike|dz5485 612|chicago lost found");
    expect(productKey(identification({ model: null, title: "Pokémon Scarlet" }))).toBe(
      "t:pokemon scarlet",
    );
    expect(productKey(identification({ model: null, title: "Headphones" }))).toBeNull();
  });
});

describe("looksPrivate", () => {
  it("catches medication, hygiene, documents and fixtures", () => {
    for (const label of [
      "prescription pill bottle",
      "Vitamin D3",
      "dietary supplement",
      "supplement bottle",
      "orthodontic retainer case",
      "mouthguard",
      "electric toothbrush",
      "passport",
      "credit card",
      "air-conditioner remote",
      "A/C remote",
      "TV remote",
      "light switch",
    ]) {
      expect(looksPrivate(label), label).toBe(true);
    }
  });

  it("leaves tradeable look-alikes alone", () => {
    for (const label of [
      "Pokémon trading card",
      "remote control car",
      "Nintendo Switch game case",
      "D&D Player's Handbook supplement",
      "AMD Radeon RX 6800 graphics card",
      "Sony WH-1000XM4 headphones",
      "Catan board game (sealed)",
      "Beats Pill+ speaker",
    ]) {
      expect(looksPrivate(label), label).toBe(false);
    }
  });
});

describe("env", () => {
  const base = {
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    ANTHROPIC_API_KEY: "k",
    VOYAGE_API_KEY: "k",
  };

  it("defaults pricing to Haiku research with a Sonnet fallback", () => {
    const env = loadEnv(base);
    expect(env.PRICE_RESEARCH_MODEL).toBe(MODELS.fast);
    expect(env.PRICE_FALLBACK_MODEL).toBe(MODELS.smart);
    expect(env.PRICE_MAX_SEARCHES).toBe(2);
    expect(env.PRICE_CACHE_TTL_DAYS).toBe(7);
    expect(env.PARALLEL_PRICING).toBe(10);
  });

  it("accepts overrides", () => {
    const env = loadEnv({ ...base, PRICE_RESEARCH_MODEL: "sonnet", PRICE_FALLBACK_MODEL: "none" });
    expect(env.PRICE_RESEARCH_MODEL).toBe(MODELS.smart);
    expect(env.PRICE_FALLBACK_MODEL).toBeNull();
  });
});
