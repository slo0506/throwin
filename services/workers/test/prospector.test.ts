import { describe, expect, it } from "vitest";
import { VoyageEmbedder } from "../src/appraiser/embeddings.js";
import { HttpMatcher, type MatchRequest, type MatchResponse } from "../src/prospector/matcher.js";
import {
  askEmbeddingText,
  embeddingHash,
  type ProspectingAsk,
  type ProspectorConfig,
  type ProspectorStore,
  prospectAsk,
  type StoredEdge,
  scoreCandidate,
  type WantCandidate,
} from "../src/prospector/prospect.js";

const MODEL = "voyage-multimodal-3.5";
const JORDAN = "u-jordan";
const MAYA = "u-maya";
const BATMOBILE = {
  kind: "exact",
  name: "LEGO Batman Batmobile Tumbler",
  brand: "LEGO",
  model: "76240",
  category: "toys/lego",
  constraints: ["built is fine"],
  anchor: null,
};

const candidate = (over: Partial<WantCandidate> = {}): WantCandidate => ({
  askId: "ask-jordan",
  wanterId: JORDAN,
  cashCeilingCents: 2000,
  itemId: "item-bat",
  giverId: MAYA,
  giverAskId: "ask-maya",
  similarity: 0.5,
  title: "Batmobile",
  category: "toys/lego",
  brand: "LEGO",
  model: "76240",
  valueMidCents: 21500,
  ...over,
});

describe("scoreCandidate", () => {
  it("trusts a matching model number even at low similarity", () => {
    expect(scoreCandidate(BATMOBILE, { ...candidate(), similarity: 0.1 }, 0.3)).toBe(0.95);
    expect(scoreCandidate(BATMOBILE, { ...candidate(), model: "76-240" }, 0.3)).toBe(0.95);
  });

  it("drops Items whose category or, for exact Asks, brand contradicts the Ask", () => {
    expect(scoreCandidate(BATMOBILE, { ...candidate(), category: "video_games" }, 0.3)).toBeNull();
    expect(scoreCandidate(BATMOBILE, { ...candidate(), brand: "Mega Bloks" }, 0.3)).toBeNull();
    // A category Ask doesn't care about brand.
    const category = { ...BATMOBILE, kind: "category", model: null };
    expect(
      scoreCandidate(category, { ...candidate(), brand: "Mega Bloks", model: null }, 0.3),
    ).toBe(0.5);
    // Subcategories still fit their top level.
    expect(
      scoreCandidate(category, { ...candidate(), category: "toys/lego/technic", model: null }, 0.3),
    ).toBe(0.5);
  });

  it("falls back to similarity, with the bar applied", () => {
    const other = { ...candidate(), model: "10497" };
    expect(scoreCandidate(BATMOBILE, other, 0.3)).toBe(0.5);
    expect(scoreCandidate(BATMOBILE, other, 0.6)).toBeNull();
    // A drafting Ask has no target: similarity alone decides.
    expect(scoreCandidate({}, { ...candidate(), category: "anything" }, 0.3)).toBe(0.5);
  });
});

describe("askEmbeddingText", () => {
  it("uses the resolved target, else the raw words", () => {
    expect(askEmbeddingText({ rawText: "the big Batmobile", target: BATMOBILE })).toBe(
      "LEGO Batman Batmobile Tumbler. LEGO. 76240. toys/lego. built is fine",
    );
    expect(askEmbeddingText({ rawText: "the big Batmobile", target: {} })).toBe(
      "the big Batmobile",
    );
    expect(embeddingHash(MODEL, "a")).not.toBe(embeddingHash(MODEL, "b"));
  });
});

class FakeStore implements ProspectorStore {
  asks: (ProspectingAsk & { status: string })[] = [];
  circles = new Map<string, string[]>();
  candidatesByCircle = new Map<string, WantCandidate[]>();
  saved: { askId: string; hash: string }[] = [];
  replaced: { askIds: string[]; edges: StoredEdge[] } | null = null;

  async getAsk(userId: string, askId: string) {
    const ask = this.asks.find((a) => a.id === askId && a.userId === userId);
    return ask ? { status: ask.status } : null;
  }
  async circlesOf(userId: string) {
    return this.circles.get(userId) ?? [];
  }
  async prospectingAsks() {
    return this.asks.filter((a) => a.status === "prospecting");
  }
  async saveAskEmbedding(askId: string, _model: string, _vector: number[], hash: string) {
    this.saved.push({ askId, hash });
  }
  async candidates(circleId: string) {
    return this.candidatesByCircle.get(circleId) ?? [];
  }
  async replaceEdges(askIds: string[], edges: StoredEdge[]) {
    this.replaced = { askIds, edges };
  }
}

const EMPTY_MATCH: MatchResponse = {
  deals: [],
  cycles_found: 0,
  cycles_balanced: 0,
  truncated: false,
  optimal: true,
};

function world(config: Partial<ProspectorConfig> = {}) {
  const store = new FakeStore();
  const embedded: string[] = [];
  const requests: MatchRequest[] = [];
  let response: MatchResponse = EMPTY_MATCH;
  const deps = {
    store,
    embedder: {
      model: MODEL,
      embedQuery: async (text: string) => {
        embedded.push(text);
        return [0.1, 0.2];
      },
    },
    matcher: {
      match: async (req: MatchRequest) => {
        requests.push(req);
        return response;
      },
    },
    config: {
      minSimilarity: 0.3,
      candidatesPerAsk: 25,
      maxEmbedsPerRun: 50,
      matcherTimeLimitSeconds: 5,
      ...config,
    },
    logger: { info: () => {} },
  };
  return {
    store,
    embedded,
    requests,
    deps,
    respond: (r: MatchResponse) => {
      response = r;
    },
  };
}

const ask = (
  id: string,
  userId: string,
  over: Partial<ProspectingAsk & { status: string }> = {},
) => ({
  id,
  userId,
  rawText: id,
  target: {},
  embeddingHash: null,
  status: "prospecting",
  ...over,
});

describe("prospectAsk", () => {
  it("skips Asks that aren't prospecting, aren't the user's, or have no Circle", async () => {
    const w = world();
    w.store.asks = [ask("ask-jordan", JORDAN, { status: "offering" })];
    expect(await prospectAsk("ask-jordan", JORDAN, w.deps)).toEqual({
      status: "skipped",
      reason: "not_prospecting",
    });
    expect(await prospectAsk("ask-jordan", MAYA, w.deps)).toMatchObject({ status: "skipped" });
    w.store.asks = [ask("ask-jordan", JORDAN)];
    expect(await prospectAsk("ask-jordan", JORDAN, w.deps)).toEqual({
      status: "skipped",
      reason: "no_circle",
    });
    expect(w.requests).toEqual([]);
  });

  it("re-embeds only changed Asks, the asker's first, within the per-run cap", async () => {
    const w = world({ maxEmbedsPerRun: 2 });
    const fresh = embeddingHash(MODEL, "ask-b");
    w.store.asks = [
      ask("ask-a", MAYA),
      ask("ask-b", MAYA, { embeddingHash: fresh }),
      ask("ask-c", MAYA),
      ask("ask-jordan", JORDAN, { target: BATMOBILE }),
    ];
    w.store.circles.set(JORDAN, ["circle-1"]);
    await prospectAsk("ask-jordan", JORDAN, w.deps);
    expect(w.store.saved.map((s) => s.askId)).toEqual(["ask-jordan", "ask-a"]);
    expect(w.embedded[0]).toContain("Batmobile Tumbler");
    expect(w.store.saved[0]?.hash).toBe(
      embeddingHash(MODEL, askEmbeddingText(w.store.asks[3] as ProspectingAsk)),
    );
  });

  it("scores candidates into edges, stores them and matches anchored on the asker", async () => {
    const w = world();
    w.store.asks = [ask("ask-jordan", JORDAN, { target: BATMOBILE }), ask("ask-maya", MAYA)];
    w.store.circles.set(JORDAN, ["circle-1", "circle-2"]);
    w.store.candidatesByCircle.set("circle-1", [
      candidate(),
      // Wrong category for Jordan's Batmobile Ask: dropped.
      candidate({ itemId: "item-mario", category: "video_games", model: "Mario", similarity: 0.9 }),
      // Maya wants Jordan's Zelda; her Ask has no target, so similarity decides.
      candidate({
        askId: "ask-maya",
        wanterId: MAYA,
        giverId: JORDAN,
        giverAskId: "ask-jordan",
        itemId: "item-zelda",
        similarity: 0.62,
        cashCeilingCents: 500,
        valueMidCents: 4200,
      }),
      // Too far from what Maya wants.
      candidate({
        askId: "ask-maya",
        wanterId: MAYA,
        giverId: JORDAN,
        itemId: "item-x",
        similarity: 0.1,
      }),
    ]);
    // In circle-2 nobody offers Jordan anything, so the matcher isn't called there.
    w.store.candidatesByCircle.set("circle-2", [
      candidate({
        askId: "ask-maya",
        wanterId: MAYA,
        giverId: JORDAN,
        itemId: "item-y",
        similarity: 0.8,
      }),
    ]);

    const outcome = await prospectAsk("ask-jordan", JORDAN, w.deps);
    expect(outcome).toMatchObject({ status: "matched", edges: 3, deals: [] });

    expect(w.store.replaced?.askIds).toEqual(["ask-jordan", "ask-maya"]);
    expect(w.store.replaced?.edges.map((e) => [e.askId, e.itemId, e.utility])).toEqual([
      ["ask-jordan", "item-bat", 0.95],
      ["ask-maya", "item-zelda", 0.62],
      ["ask-maya", "item-y", 0.8],
    ]);

    expect(w.requests).toHaveLength(1);
    const req = w.requests[0];
    expect(req).toMatchObject({ anchor_user: JORDAN, time_limit_seconds: 5 });
    expect(req?.edges).toEqual([
      {
        from_user: JORDAN,
        to_user: MAYA,
        item_id: "item-bat",
        utility: 0.95,
        confidence: 0.95,
        kind: "explicit",
        ask_id: "ask-jordan",
        giver_ask_id: "ask-maya",
        value_cents: 21500,
        cash_ceiling_cents: 2000,
      },
      expect.objectContaining({ from_user: MAYA, item_id: "item-zelda", cash_ceiling_cents: 500 }),
    ]);
  });

  it("returns the matcher's Deals, best first, with their Circle", async () => {
    const w = world();
    w.store.asks = [ask("ask-jordan", JORDAN)];
    w.store.circles.set(JORDAN, ["circle-1"]);
    w.store.candidatesByCircle.set("circle-1", [candidate({ model: null, brand: null })]);
    const deal = (score: number) => ({
      users: [JORDAN, MAYA],
      item_legs: [],
      cash_legs: [],
      fairness: [],
      cash_moved_cents: 0,
      score,
    });
    w.respond({ ...EMPTY_MATCH, deals: [deal(0.4), deal(1.2)] });
    const outcome = await prospectAsk("ask-jordan", JORDAN, w.deps);
    expect(
      outcome.status === "matched" && outcome.deals.map((d) => [d.circleId, d.deal.score]),
    ).toEqual([
      ["circle-1", 1.2],
      ["circle-1", 0.4],
    ]);
  });
});

describe("HttpMatcher", () => {
  it("posts to /v1/match and validates the reply", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(EMPTY_MATCH), { status: 200 });
    }) as unknown as typeof fetch;
    const matcher = new HttpMatcher("http://matcher.internal:8000/", fetchImpl);
    expect(await matcher.match({ edges: [], anchor_user: JORDAN })).toEqual(EMPTY_MATCH);
    expect(calls).toEqual([
      { url: "http://matcher.internal:8000/v1/match", body: { edges: [], anchor_user: JORDAN } },
    ]);
  });

  it("throws on an error status or a malformed reply", async () => {
    const reply = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(
      new HttpMatcher("http://m", reply(500, { e: 1 })).match({ edges: [] }),
    ).rejects.toThrow(/matcher 500/);
    await expect(
      new HttpMatcher("http://m", reply(200, { deals: "no" })).match({ edges: [] }),
    ).rejects.toThrow();
  });
});

describe("VoyageEmbedder.embedQuery", () => {
  it("sends text only, as a query", async () => {
    let sent: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const vector = await new VoyageEmbedder("k", fetchImpl, []).embedQuery("a Batmobile");
    expect(vector).toEqual([0.1, 0.2]);
    expect(sent).toEqual({
      model: "voyage-multimodal-3.5",
      input_type: "query",
      inputs: [{ content: [{ type: "text", text: "a Batmobile" }] }],
    });
  });
});
