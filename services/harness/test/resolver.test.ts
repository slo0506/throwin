import { describe, expect, it } from "vitest";
import { dollarAmounts, usd, usdRange } from "../src/format.js";
import { greetingFor, parseFrontmatter } from "../src/prompts.js";
import { ClaudeTargetResolver, type ResolverRun } from "../src/resolver.js";
import { FakeModelClient } from "../src/testing.js";
import { testPrompts } from "./support.js";

const extraction = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "exact",
    name: "LEGO Batman Batmobile Tumbler 76240",
    brand: "LEGO",
    model: "76240",
    category: "toys/lego",
    constraints: ["built is fine"],
    retail_cents: 26999,
    used_low_cents: 18000,
    used_high_cents: 25000,
    confidence: 0.92,
    alternatives: [],
    ...overrides,
  });

describe("ClaudeTargetResolver", () => {
  it("researches with at most 2 searches, resumes pause_turn, then extracts a target", async () => {
    const model = new FakeModelClient([
      {
        text: "Searching",
        stopReason: "pause_turn",
        usage: { server_tool_use: { web_search_requests: 1 } } as never,
      },
      { text: "It's the 76240 Tumbler. Retail $269.99, used $180 to $250." },
      { text: extraction() },
    ]);
    const runs: ResolverRun[] = [];
    const target = await new ClaudeTargetResolver(model).resolve(
      { text: "the big Lego Batmobile, built is fine" },
      async (r) => {
        runs.push(r);
      },
    );
    expect(target).toMatchObject({
      kind: "exact",
      name: "LEGO Batman Batmobile Tumbler 76240",
      anchor: { retail_cents: 26999, used_low_cents: 18000, used_high_cents: 25000 },
      constraints: ["built is fine"],
    });
    const [research, resumed, extract] = model.requests;
    expect(research?.model).toBe("claude-sonnet-5-5");
    expect(research?.tools).toEqual([
      { type: "web_search_20260318", name: "web_search", max_uses: 2 },
    ]);
    expect(resumed?.messages).toHaveLength(2);
    expect(extract?.model).toBe("claude-haiku-4-5-20251001");
    expect(extract?.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(extract?.messages)).toContain(
      '<untrusted_content source=\\"product_research\\">',
    );
    expect(runs.map((r) => [r.model, r.searches, r.outcome])).toEqual([
      ["claude-sonnet-5-5", 1, "ok"],
      ["claude-haiku-4-5-20251001", 0, "ok"],
    ]);
  });

  it("drops an inverted or missing used range instead of inventing one", async () => {
    const model = new FakeModelClient([
      { text: "Not sure of prices." },
      { text: extraction({ used_low_cents: 30000, used_high_cents: 20000 }) },
      { text: "Nothing." },
      { text: extraction({ used_low_cents: null, used_high_cents: null, retail_cents: null }) },
    ]);
    const resolver = new ClaudeTargetResolver(model);
    expect((await resolver.resolve({ text: "x" }, async () => {})).anchor).toBeNull();
    expect((await resolver.resolve({ text: "y" }, async () => {})).anchor).toBeNull();
  });

  it("records an invalid extraction and throws", async () => {
    const model = new FakeModelClient([{ text: "notes" }, { text: "not json" }]);
    const runs: ResolverRun[] = [];
    await expect(
      new ClaudeTargetResolver(model).resolve({ text: "x" }, async (r) => {
        runs.push(r);
      }),
    ).rejects.toThrow(/invalid extraction/);
    expect(runs.at(-1)?.outcome).toBe("invalid_output");
  });
});

describe("money and prompts", () => {
  it("formats cents as dollars and finds dollar amounts", () => {
    expect(usd(26999)).toBe("$270");
    expect(usd(450)).toBe("$4.50");
    expect(usd(120000)).toBe("$1,200");
    expect(usdRange(18000, 25000)).toBe("$180 to $250");
    expect(dollarAmounts("about $180 to $250, or $1,200 or $4.50")).toEqual([180, 250, 1200, 5]);
  });

  it("loads the GM prompt, every skill and a versioned hash", async () => {
    const prompts = await testPrompts();
    expect(prompts.version).toMatch(/^gm-\d+\.\d+\.\d+\+[0-9a-f]{8}$/);
    expect([...prompts.skills.keys()].sort()).toEqual([
      "ask-resolution",
      "deal-explanation",
      "handoff-help",
      "intake",
      "offer-building",
      "safety-escalation",
      "shelf-coaching",
    ]);
    expect(prompts.system).not.toContain("{{");
    // House style: no em dashes in anything the GM reads or says.
    for (const text of [prompts.system, ...[...prompts.skills.values()].map((s) => s.body)]) {
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
    expect(greetingFor(prompts, "Sam")).toMatch(/^Hi Sam, I'm your GM/);
    expect(greetingFor(prompts, null)).toMatch(/^Hi, I'm your GM/);
  });

  it("parses frontmatter", () => {
    expect(parseFrontmatter('---\nname: x\ngreeting: "Hi {first_name}"\n---\nBody')).toEqual({
      meta: { name: "x", greeting: "Hi {first_name}" },
      body: "Body",
    });
    expect(parseFrontmatter("No frontmatter")).toEqual({ meta: {}, body: "No frontmatter" });
  });
});

describe("ClaudeTargetResolver product images", () => {
  const resolveWith = async (
    input: { text?: string; url?: string },
    pages: Record<string, string | null>,
    search: string | null,
  ) => {
    const model = new FakeModelClient([
      { text: "It's the 76240 Tumbler." },
      { text: extraction() },
    ]);
    const searched: string[] = [];
    const resolver = new ClaudeTargetResolver(
      model,
      undefined,
      async (urls) => (urls.length ? (pages[urls[0] as string] ?? null) : null),
      async (query) => {
        searched.push(query);
        return search;
      },
    );
    const target = await resolver.resolve(input, async () => {});
    return { target, searched };
  };

  it("prefers the user's own link, then the image search, never asking twice", async () => {
    const link = "https://shop.example.com/my-listing";
    const fromLink = await resolveWith(
      { text: "this one", url: link },
      { [link]: "https://shop.example.com/listing.jpg" },
      "https://img.example.com/search.jpg",
    );
    expect(fromLink.target.image_url).toBe("https://shop.example.com/listing.jpg");
    expect(fromLink.searched).toEqual([]);

    const fromSearch = await resolveWith(
      { text: "the Batmobile" },
      {},
      "https://img.example.com/search.jpg",
    );
    expect(fromSearch.target.image_url).toBe("https://img.example.com/search.jpg");
    expect(fromSearch.searched).toEqual(["LEGO Batman Batmobile Tumbler 76240"]);

    const none = await resolveWith({ text: "the Batmobile" }, {}, null);
    expect(none.target.image_url).toBeNull();
  });
});
