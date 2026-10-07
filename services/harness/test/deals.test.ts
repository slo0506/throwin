import type { CounterCardData, CounterChange, DealSheet } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import type { DealDesk } from "../src/deals.js";
import { GmService } from "../src/service.js";
import type { FakeStep } from "../src/testing.js";
import {
  ALICE,
  BOB,
  lastToolResults,
  makeWorld,
  NOW,
  resultText,
  testPrompts,
  turn,
} from "./support.js";

const DEAL = "dddddddd-0000-4000-8000-000000000001";
const GALAXY = "bbbbbbbb-0000-4000-8000-0000000000a1";
const ZELDA = "aaaaaaaa-0000-4000-8000-0000000000a2";
const JACKET = "bbbbbbbb-0000-4000-8000-0000000000a3";

const alice = { user_id: ALICE, first_name: "Alice", photo_url: null };
const bob = { user_id: BOB, first_name: "Bob", photo_url: null };
const item = (id: string, title: string, low: number, high: number) => ({
  id,
  title,
  category: null,
  brand: null,
  model: null,
  condition_grade: "A" as const,
  value: {
    low_cents: low,
    mid_cents: (low + high) / 2,
    high_cents: high,
    currency: "USD" as const,
  },
  photo_url: null,
});

// Galaxy Explorer for Zelda; Alice adds $28.
const SHEET: DealSheet = {
  id: DEAL,
  status: "pending_approvals",
  expires_at: "2026-10-05T12:00:00.000Z",
  gives: [item(ZELDA, "Zelda", 3500, 4500)],
  give_to: bob,
  gets: [item(GALAXY, "Galaxy Explorer", 7500, 8500)],
  get_from: bob,
  you_give: item(ZELDA, "Zelda", 3500, 4500),
  you_get: item(GALAXY, "Galaxy Explorer", 7500, 8500),
  cash: { pay_cents: 2800, receive_cents: 0 },
  fairness: { give_cents: 4000, get_cents: 8000 },
  loop: [],
  throw_ins: [],
  participants: [
    { ...alice, approval: "pending" },
    { ...bob, approval: "pending" },
  ],
  your_approval: "pending",
  why: null,
  your_ask_id: null,
  counter: null,
  counters_left: 3,
  superseded_by: null,
};

const CARD: CounterCardData = {
  deal_id: DEAL,
  changes: [{ op: "add", item_id: JACKET }],
  lines: [
    {
      op: "add",
      item: item(JACKET, "Vintage Nike windbreaker", 3000, 4000),
      giver: bob,
      receiver: alice,
    },
  ],
  gives: SHEET.gives,
  gets: [...SHEET.gets, item(JACKET, "Vintage Nike windbreaker", 3000, 4000)],
  cash: { pay_cents: 5775, receive_cents: 0 },
  cash_now: SHEET.cash,
  waiting_on: [bob],
};

class FakeDesk implements DealDesk {
  previews: { userId: string; dealId: string; changes: CounterChange[] }[] = [];
  problem: { problem: string; message: string } | null = null;
  async list() {
    return [SHEET];
  }
  async preview(userId: string, dealId: string, changes: CounterChange[]) {
    this.previews.push({ userId, dealId, changes });
    return this.problem ?? CARD;
  }
}

async function world(steps: FakeStep[], desk: DealDesk | null = new FakeDesk()) {
  const base = await makeWorld();
  base.data.addNetworkItem({
    id: JACKET,
    ownerId: BOB,
    ownerFirstName: "Bob",
    title: "Vintage Nike windbreaker",
    valueLowCents: 3000,
    valueMidCents: 3500,
    valueHighCents: 4000,
    readiness: "showcase",
  });
  base.model.push(...steps);
  const gm = new GmService({
    data: base.data,
    model: base.model,
    prompts: await testPrompts(),
    resolver: base.resolver,
    now: () => NOW,
    ...(desk && { deals: desk }),
  });
  return { ...base, gm, desk };
}

describe("deals and counters", () => {
  it("reads the user's Deals and stages the counter they asked for as a card", async () => {
    const w = await world([
      { tools: [{ name: "get_deals", input: {} }] },
      { tools: [{ name: "search_network", input: { query: "nike" } }] },
      {
        tools: [
          {
            name: "stage_counter",
            input: { deal_id: DEAL, changes: [{ op: "add", item_id: JACKET }] },
          },
        ],
      },
      (params) => {
        const text = lastToolResults(params).map(resultText).join("");
        expect(text).toContain("Shown to the user as a counter_card card");
        expect(text).toContain("the user adds $57.75, instead of: the user adds $28");
        expect(text).toContain("You can't send it for them");
        return { text: "Here's the counter. Tap Send if it looks right." };
      },
    ]);
    const { events } = await turn(w, {
      text: "Can we get a little more? Like that vintage Nike thing",
    });
    const card = events.find((e) => e.event === "component");
    expect(card?.data).toMatchObject({ kind: "counter_card", data: { deal_id: DEAL } });
    expect((w.desk as FakeDesk).previews).toEqual([
      { userId: ALICE, dealId: DEAL, changes: [{ op: "add", item_id: JACKET }] },
    ]);
    // The card comes back with the conversation.
    const convo = await w.gm.getConversation(ALICE);
    expect(convo.messages.flatMap((m) => m.components.map((c) => c.kind))).toContain(
      "counter_card",
    );
  });

  it("fences other people's titles and names when it lists Deals", async () => {
    const w = await world([
      { tools: [{ name: "get_deals", input: {} }] },
      (params) => {
        const text = lastToolResults(params).map(resultText).join("");
        expect(text).toContain(`deal_id: ${DEAL}`);
        expect(text).toContain("waiting on the user's approval");
        expect(text).toMatch(/untrusted_content[\s\S]*Galaxy Explorer/);
        expect(text).toContain("counters left: 3");
        return { text: "You have 1 deal waiting on you." };
      },
    ]);
    await turn(w, { text: "What's going on with my deals?" });
  });

  it("explains a counter that can't work, and never stages IDs it wasn't shown", async () => {
    const desk = new FakeDesk();
    desk.problem = { problem: "unbalanced", message: "That would leave someone too far from even" };
    const w = await world(
      [
        { tools: [{ name: "get_deals", input: {} }] },
        {
          tools: [
            {
              name: "stage_counter",
              input: { deal_id: DEAL, changes: [{ op: "add", item_id: ZELDA }] },
            },
          ],
        },
        (params) => {
          expect(lastToolResults(params).map(resultText).join("")).toContain("too far from even");
          return {
            tools: [
              {
                name: "stage_counter",
                input: {
                  deal_id: DEAL,
                  changes: [{ op: "add", item_id: "cccccccc-0000-4000-8000-000000000001" }],
                },
              },
            ],
          };
        },
        (params) => {
          expect(lastToolResults(params).map(resultText).join("")).toMatch(
            /not .*(issued|seen|shown)/i,
          );
          return { text: "That won't balance. Want to offer something too?" };
        },
      ],
      desk,
    );
    const { events } = await turn(w, { text: "Ask for my Zelda back as well" });
    expect(events.some((e) => e.event === "component")).toBe(false);
    expect(desk.previews).toHaveLength(1);
  });

  it("says counters are off when there's no desk", async () => {
    const w = await world(
      [
        { tools: [{ name: "get_deals", input: {} }] },
        (params) => {
          expect(lastToolResults(params).map(resultText).join("")).toContain("aren't available");
          return { text: "I can't reach your deals right now." };
        },
      ],
      null,
    );
    await turn(w, { text: "Show my deals" });
  });
});
