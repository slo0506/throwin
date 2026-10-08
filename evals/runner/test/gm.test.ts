import { fileURLToPath } from "node:url";
import { FakeModelClient } from "@throwin/harness";
import { describe, expect, it } from "vitest";
import { isCaptureCase, loadCases, type SnapshotCase } from "../src/cases.js";
import { GM_SUITES, GmCaseState, GmExpect, isGmCase, runGmCase } from "../src/gm.js";

const casesDir = fileURLToPath(new URL("../../cases", import.meta.url));

async function gmCases(): Promise<SnapshotCase[]> {
  return (await loadCases(casesDir))
    .filter((c): c is SnapshotCase => !isCaptureCase(c))
    .filter(isGmCase);
}

async function gmCase(id: string): Promise<SnapshotCase> {
  const found = (await gmCases()).find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

describe("GM eval cases", () => {
  it("cover every GM suite and parse as GM state and expectations", async () => {
    const cases = await gmCases();
    for (const suite of GM_SUITES) {
      expect(cases.filter((c) => c.suite === suite).length).toBeGreaterThanOrEqual(5);
    }
    for (const c of cases) {
      const state = GmCaseState.safeParse(c.state);
      const expectation = GmExpect.safeParse(c.expect);
      expect(state.success, `${c.id} state: ${state.error?.message}`).toBe(true);
      expect(expectation.success, `${c.id} expect: ${expectation.error?.message}`).toBe(true);
    }
  });

  it("give every safety case a negative twin that points back", async () => {
    const cases = await gmCases();
    const byId = new Map(cases.map((c) => [c.id, c]));
    for (const c of cases.filter((x) => x.suite === "safety")) {
      expect(c.twin, `${c.id} has no twin`).toBeDefined();
      const twin = byId.get(c.twin as string);
      expect(twin?.suite, `${c.id} twin ${c.twin} missing`).toBe("safety");
      expect(twin?.twin).toBe(c.id);
    }
  });

  it("contain no em dashes", async () => {
    for (const c of await gmCases())
      expect(JSON.stringify(c)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("runGmCase", () => {
  it("passes when a write with an unseen ID is rejected and nothing changes", async () => {
    const c = await gmCase("safety-unseen-id-write");
    const model = new FakeModelClient([
      {
        tools: [
          {
            name: "set_offer_set",
            input: {
              ask_id: "dddddddd-1111-4000-8000-000000000001",
              item_ids: ["99999999-0000-4000-8000-000000000099"],
              cash_ceiling_cents: 0,
            },
          },
        ],
      },
      { text: "I can only add Items from your Shelf." },
    ]);
    const result = await runGmCase(c, model);
    expect(result.failures).toEqual([]);
    expect(result.tools).toEqual([{ name: "set_offer_set", ok: false }]);
  });

  it("grades a counter on exactly what it staged", async () => {
    const c = await gmCase("negotiation-asks-for-more-vintage-nike");
    const NIKE = "bbbbbbbb-2222-4000-8000-0000000000a2";
    const BUS = "bbbbbbbb-2222-4000-8000-0000000000a3";
    const script = (itemId: string) =>
      new FakeModelClient([
        { tools: [{ name: "get_deals", input: {} }] },
        { tools: [{ name: "search_network", input: {} }] },
        {
          tools: [
            {
              name: "stage_counter",
              input: {
                deal_id: "dddddddd-2222-4000-8000-000000000001",
                changes: [{ op: "add", item_id: itemId }],
              },
            },
          ],
        },
        { text: "Here's the counter. Tap Send if it looks right." },
      ]);
    const good = await runGmCase(c, script(NIKE));
    expect(good.failures).toEqual([]);
    const bad = await runGmCase(c, script(BUS));
    expect(bad.failures).toContain(`counter was add:${BUS}, not add:${NIKE}`);
  });

  it("fails a reply that quotes a price no tool or session showed", async () => {
    const c = await gmCase("grounding-shelf-value-from-session");
    const good = await runGmCase(c, new FakeModelClient([{ text: "About $90 to $130." }]));
    expect(good.pass).toBe(true);
    const bad = await runGmCase(c, new FakeModelClient([{ text: "It's worth $95 to $130." }]));
    expect(bad.failures).toContain("ungrounded amounts in text: $95");
  });

  it("grades the end of intake on mode and Asks", async () => {
    const c = await gmCase("intake-confirm-finishes");
    const model = new FakeModelClient([
      { tools: [{ name: "finish_intake", input: {} }] },
      {
        tools: [
          {
            name: "present_recap",
            input: {
              paragraph: "You're into LEGO and Switch games and after the Batmobile.",
              sample_decisions: [
                {
                  give_item_id: "aaaaaaaa-1111-4000-8000-000000000002",
                  get: "the Batmobile",
                  verdict: "yes",
                  why: "Games for LEGO.",
                },
                {
                  give_item_id: "aaaaaaaa-1111-4000-8000-000000000003",
                  get: "the Batmobile",
                  verdict: "yes",
                  why: "Close in value.",
                },
                {
                  give_item_id: "aaaaaaaa-1111-4000-8000-000000000001",
                  get: "a Batman minifig",
                  verdict: "no",
                  why: "Too lopsided.",
                },
              ],
            },
          },
        ],
      },
      { tools: [{ name: "finish_intake", input: {} }] },
      { text: "You're set. I'll ping you when I find a deal." },
    ]);
    const result = await runGmCase(c, model);
    expect(result.failures).toEqual([]);
    expect(result.tools.map((t) => `${t.name}:${t.ok}`)).toEqual([
      "finish_intake:false",
      "present_recap:true",
      "finish_intake:true",
    ]);
  });
});
