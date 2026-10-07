import { DealSheet } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import type { BalanceRequest, BalanceResult, Balancer } from "../src/lib/matcher.js";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const ZELDA = "aaaaaaaa-0000-4000-8000-000000000001";
const KIRBY = "aaaaaaaa-0000-4000-8000-000000000002";
const GALAXY = "bbbbbbbb-0000-4000-8000-000000000001";
const JACKET = "bbbbbbbb-0000-4000-8000-000000000002";
const ALICE_ASK = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB_ASK = "bbbbbbbb-0000-4000-8000-0000000000b1";
const DEAL = "dddddddd-0000-4000-8000-000000000001";

/** 2 people, the matcher's rules: whoever's ahead pays down to the tolerance. */
class FakeBalancer implements Balancer {
  calls: BalanceRequest[] = [];
  balanced = true;

  async balance(req: BalanceRequest): Promise<BalanceResult> {
    this.calls.push(req);
    const net = (u: string) =>
      req.item_legs.reduce(
        (s, l) => s + (l.receiver === u ? l.value_cents : 0) - (l.giver === u ? l.value_cents : 0),
        0,
      );
    const [a, b] = req.people;
    if (!this.balanced || !a || !b) {
      return { balanced: false, cash_legs: [], fairness: [], cash_moved_cents: 0 };
    }
    const ahead = net(a.user) > 0 ? a : b;
    const behind = ahead === a ? b : a;
    const gets = req.item_legs
      .filter((l) => l.receiver === ahead.user)
      .reduce((s, l) => s + l.value_cents, 0);
    const owed = Math.max(0, net(ahead.user) - Math.max(1000, Math.floor(gets * 0.15)));
    if (owed > ahead.cash_ceiling_cents) {
      return { balanced: false, cash_legs: [], fairness: [], cash_moved_cents: 0 };
    }
    return {
      balanced: true,
      cash_legs: owed ? [{ payer: ahead.user, payee: behind.user, amount_cents: owed }] : [],
      fairness: [],
      cash_moved_cents: owed,
    };
  }
}

function setup(options: { balancer?: Balancer | null } = {}) {
  const balancer = options.balancer === undefined ? new FakeBalancer() : options.balancer;
  const h = makeHarness(balancer ? { balancer } : {});
  const item = (id: string, ownerId: string, title: string, mid: number | null) =>
    h.repo.addItem({
      id,
      ownerId,
      title,
      valueLowCents: mid && mid - 500,
      valueMidCents: mid,
      valueHighCents: mid && mid + 500,
      // Showcase: sure of what it is, a narrow range, and good photos from every angle.
      identityConf: 0.95,
      photoScore: 90,
      missingAngles: [],
    });
  item(ZELDA, ALICE, "Zelda", 4000);
  item(KIRBY, ALICE, "Kirby", 3000);
  item(GALAXY, BOB, "Galaxy Explorer", 8000);
  item(JACKET, BOB, "Vintage Nike windbreaker", 3500);
  h.repo.addAsk({ id: ALICE_ASK, userId: ALICE, status: "prospecting", cashCeilingCents: 6000 });
  h.repo.addAsk({ id: BOB_ASK, userId: BOB, status: "prospecting" });
  // Galaxy Explorer for Zelda, Alice adds $28.
  h.repo.addDeal({
    id: DEAL,
    legs: [
      { giverId: BOB, receiverId: ALICE, itemId: GALAXY, askId: ALICE_ASK, giverAskId: BOB_ASK },
      { giverId: ALICE, receiverId: BOB, itemId: ZELDA, askId: BOB_ASK, giverAskId: ALICE_ASK },
    ],
    throwIns: [{ payerId: ALICE, payeeId: BOB, amountCents: 2800 }],
  });
  const call = async (path: string, as = ALICE, body?: unknown) =>
    h.request(path, {
      method: "POST",
      as,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const read = async (id: string, as = ALICE) =>
    DealSheet.parse(await (await h.request(`/v1/deals/${id}`, { as })).json());
  const counter = (changes: unknown[], as = ALICE) =>
    call(`/v1/deals/${DEAL}/counters`, as, { changes });
  return { ...h, balancer, call, read, counter };
}

describe("counters", () => {
  it("asks for 1 more Item, re-balances the cash, and waits on the other side", async () => {
    const { counter, read, call, balancer, request } = setup();
    // "Can we get a little more? Like the vintage Nike thing."
    const res = await counter([{ op: "add", item_id: JACKET }]);
    expect(res.status).toBe(201);
    const alice = DealSheet.parse(await res.json());
    expect(alice.counter).toMatchObject({
      proposed_by: { user_id: ALICE },
      changes: [
        {
          op: "add",
          item: { id: JACKET },
          giver: { user_id: BOB },
          receiver: { user_id: ALICE },
        },
      ],
      gets: [{ id: GALAXY }, { id: JACKET }],
      gives: [{ id: ZELDA }],
      // $115 for $40: 15% of $115 is $17.25, so Alice adds $57.75.
      cash: { pay_cents: 5775, receive_cents: 0 },
      fairness: { give_cents: 4000, get_cents: 11500 },
      your_answer: null,
      waiting_on: [{ user_id: BOB }],
    });
    expect(alice.counters_left).toBe(2);
    // The matcher saw each person's own ceiling and every Item's mid value.
    const sentToMatcher = (balancer as FakeBalancer).calls.at(-1);
    expect(sentToMatcher?.people).toEqual(
      expect.arrayContaining([
        { user: ALICE, cash_ceiling_cents: 6000 },
        { user: BOB, cash_ceiling_cents: 0 },
      ]),
    );
    expect(sentToMatcher?.item_legs.map((l) => [l.item_id, l.value_cents])).toEqual([
      [GALAXY, 8000],
      [ZELDA, 4000],
      [JACKET, 3500],
    ]);

    const bob = await read(DEAL, BOB);
    expect(bob.counter?.your_answer).toBe("pending");
    expect(JSON.stringify(bob)).not.toContain("6000");

    // Nobody approves while it's open, and Bob's Next up asks him to answer instead.
    const approve = await call(`/v1/deals/${DEAL}/approve`, BOB);
    expect(approve.status).toBe(409);
    expect(await errorCode(approve)).toBe("counter_open");
    const next = await (await request("/v1/next-up", { as: BOB })).json();
    expect(next.items[0]).toMatchObject({
      kind: "answer_counter",
      title: "Alice asked for your Vintage Nike windbreaker too",
      deal_id: DEAL,
    });
    expect(next.items.some((i: { kind: string }) => i.kind === "approve_deal")).toBe(false);
  });

  it("accepting makes a new version that everyone approves again", async () => {
    const { counter, call, read, repo } = setup();
    const sent = DealSheet.parse(await (await counter([{ op: "add", item_id: JACKET }])).json());
    const res = await call(`/v1/deals/${DEAL}/counters/${sent.counter?.id}/accept`, BOB);
    expect(res.status).toBe(200);
    const next = DealSheet.parse(await res.json());
    expect(next.id).not.toBe(DEAL);
    expect(next.gives.map((i) => i.id)).toEqual([GALAXY, JACKET]);
    expect(next.cash).toEqual({ pay_cents: 0, receive_cents: 5775 });
    expect(next.participants.every((p) => p.approval === "pending")).toBe(true);
    expect(next.counter).toBeNull();
    expect(next.counters_left).toBe(2);

    const old = await read(DEAL);
    expect(old).toMatchObject({ status: "cancelled", superseded_by: next.id });
    expect(repo.items.find((i) => i.id === JACKET)?.reservedByDealId).toBe(next.id);
    expect(repo.asks.every((a) => a.status === "proposed")).toBe(true);
  });

  it("an added Item that still needs photos holds the new version until they're in", async () => {
    const { counter, call, read, repo, request } = setup();
    const jacket = repo.items.find((i) => i.id === JACKET);
    if (jacket) jacket.photoScore = 40;
    const sent = DealSheet.parse(await (await counter([{ op: "add", item_id: JACKET }])).json());
    const res = await call(`/v1/deals/${DEAL}/counters/${sent.counter?.id}/accept`, BOB);
    // Nobody sees a staged Deal, so Bob gets the old one back, pointing at the new one.
    const old = DealSheet.parse(await res.json());
    expect(old.id).toBe(DEAL);
    expect(old.status).toBe("cancelled");
    expect(old.superseded_by).toBeTruthy();
    expect((await read(DEAL, ALICE)).superseded_by).toBe(old.superseded_by);
    expect((await request(`/v1/deals/${old.superseded_by}`, { as: BOB })).status).toBe(404);
  });

  it("declining leaves the Deal as it was", async () => {
    const { counter, call, read, repo } = setup();
    const sent = DealSheet.parse(await (await counter([{ op: "add", item_id: JACKET }])).json());
    const res = await call(`/v1/deals/${DEAL}/counters/${sent.counter?.id}/decline`, BOB);
    expect(DealSheet.parse(await res.json()).counter).toBeNull();
    expect(repo.items.find((i) => i.id === JACKET)?.reservedByDealId).toBeNull();
    expect((await call(`/v1/deals/${DEAL}/approve`, BOB)).status).toBe(200);
    expect((await read(DEAL)).counters_left).toBe(2);

    const again = await call(`/v1/deals/${DEAL}/counters/${sent.counter?.id}/accept`, BOB);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("counter_closed");
  });

  it("a sweetener from your own Shelf goes to the other side", async () => {
    const { counter } = setup();
    const res = await counter([{ op: "add", item_id: KIRBY }]);
    const sheet = DealSheet.parse(await res.json());
    expect(sheet.counter?.gives.map((i) => i.id)).toEqual([ZELDA, KIRBY]);
    // $80 for $70: inside the $12 tolerance, so no cash at all.
    expect(sheet.counter?.cash).toEqual({ pay_cents: 0, receive_cents: 0 });
  });

  it("the proposer can take it back; only the people asked can answer", async () => {
    const { counter, call } = setup();
    const sent = DealSheet.parse(await (await counter([{ op: "add", item_id: JACKET }])).json());
    const id = sent.counter?.id;
    expect((await call(`/v1/deals/${DEAL}/counters/${id}/accept`, ALICE)).status).toBe(404);
    expect((await call(`/v1/deals/${DEAL}/counters/${id}/withdraw`, BOB)).status).toBe(404);
    const back = await call(`/v1/deals/${DEAL}/counters/${id}/withdraw`, ALICE);
    expect(DealSheet.parse(await back.json()).counter).toBeNull();
    expect((await call(`/v1/deals/${DEAL}/counters/not-a-uuid/withdraw`)).status).toBe(404);
  });

  it("refuses what can't work, in plain words", async () => {
    const { counter, repo, balancer } = setup();
    const OTHER = "cccccccc-0000-4000-8000-000000000001";
    repo.addItem({ id: OTHER, ownerId: "33333333-3333-4333-8333-333333333333", title: "x" });
    const cases: [unknown[], number, string][] = [
      [[{ op: "add", item_id: OTHER }], 422, "unavailable"],
      [[{ op: "add", item_id: GALAXY }], 400, "already_in_deal"],
      [[{ op: "remove", item_id: KIRBY }], 400, "not_in_deal"],
      [[{ op: "remove", item_id: ZELDA }], 422, "empty_side"],
    ];
    for (const [changes, status, code] of cases) {
      const res = await counter(changes);
      expect(res.status, code).toBe(status);
      expect(await errorCode(res)).toBe(code);
    }
    const jacket = repo.items.find((i) => i.id === JACKET);
    if (jacket) jacket.willingness = "not_available";
    expect(await errorCode(await counter([{ op: "add", item_id: JACKET }]))).toBe("unavailable");
    if (jacket) jacket.willingness = "would_trade";
    const kirby = repo.items.find((i) => i.id === KIRBY);
    if (kirby) kirby.valueMidCents = null;
    expect(await errorCode(await counter([{ op: "add", item_id: KIRBY }]))).toBe("not_priced");
    (balancer as FakeBalancer).balanced = false;
    expect(await errorCode(await counter([{ op: "add", item_id: JACKET }]))).toBe("unbalanced");

    for (const body of [
      [],
      [{ op: "swap", item_id: JACKET }],
      Array(4).fill({ op: "add", item_id: JACKET }),
    ]) {
      expect((await counter(body)).status).toBe(400);
    }
  });

  it("stops after 3 counters", async () => {
    const { counter, call } = setup();
    for (let round = 0; round < 3; round++) {
      const sent = DealSheet.parse(await (await counter([{ op: "add", item_id: JACKET }])).json());
      await call(`/v1/deals/${DEAL}/counters/${sent.counter?.id}/decline`, BOB);
    }
    const res = await counter([{ op: "add", item_id: JACKET }]);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("no_rounds_left");
  });

  it("answers 503 without the matcher", async () => {
    const { counter } = setup({ balancer: null });
    const res = await counter([{ op: "add", item_id: JACKET }]);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("counters_unavailable");
  });
});
