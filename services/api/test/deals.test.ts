import { DealSheet, DealSheetsResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const CAROL = "33333333-3333-4333-8333-333333333333";
const ZELDA = "aaaaaaaa-0000-4000-8000-000000000001";
const GALAXY = "bbbbbbbb-0000-4000-8000-000000000001";
const MARIO = "cccccccc-0000-4000-8000-000000000001";
const ALICE_ASK = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB_ASK = "bbbbbbbb-0000-4000-8000-0000000000b1";
const DEAL = "dddddddd-0000-4000-8000-000000000001";

function setup() {
  const h = makeHarness();
  h.repo.addUser(CAROL, { displayName: "Carol" });
  h.repo.addItem({
    id: ZELDA,
    ownerId: ALICE,
    title: "Zelda: Tears of the Kingdom",
    conditionGrade: "A",
    valueLowCents: 3500,
    valueMidCents: 4200,
    valueHighCents: 5000,
    thumbnailPath: "alice/zelda.jpg",
  });
  h.repo.addItem({
    id: GALAXY,
    ownerId: BOB,
    title: "Galaxy Explorer",
    valueLowCents: 7000,
    valueMidCents: 8500,
    valueHighCents: 9900,
  });
  h.repo.addItem({ id: MARIO, ownerId: CAROL, title: "Mario Wonder" });
  h.repo.addAsk({ id: ALICE_ASK, userId: ALICE, status: "prospecting" });
  h.repo.addAsk({ id: BOB_ASK, userId: BOB, status: "prospecting" });
  h.repo.addDeal({
    id: DEAL,
    legs: [
      { giverId: BOB, receiverId: ALICE, itemId: GALAXY, askId: ALICE_ASK },
      { giverId: ALICE, receiverId: BOB, itemId: ZELDA, askId: BOB_ASK },
    ],
    throwIns: [{ payerId: ALICE, payeeId: BOB, amountCents: 2000 }],
    whys: {
      [ALICE]: "You said Galaxy Explorer was your white whale.",
      [BOB]: "Zelda, like you asked.",
    },
  });
  const call = (method: string, path: string, as = ALICE, body?: unknown) =>
    h.request(path, { method, as, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const sheet = async (res: Response) => DealSheet.parse(await res.json());
  return { ...h, call, sheet };
}

describe("Deal Sheets", () => {
  it("shows each participant the Deal from their own side", async () => {
    const { call, sheet } = setup();
    const alice = await sheet(await call("GET", `/v1/deals/${DEAL}`));
    expect(alice).toMatchObject({
      status: "pending_approvals",
      you_give: { id: ZELDA, title: "Zelda: Tears of the Kingdom", condition_grade: "A" },
      give_to: { user_id: BOB, first_name: "Bob" },
      you_get: { id: GALAXY, value: { low_cents: 7000, mid_cents: 8500, high_cents: 9900 } },
      get_from: { user_id: BOB },
      cash: { pay_cents: 2000, receive_cents: 0 },
      fairness: { give_cents: 4200, get_cents: 8500 },
      your_approval: "pending",
      why: "You said Galaxy Explorer was your white whale.",
      // Only the caller's own Ask: Bob's Ask is never on Alice's sheet.
      your_ask_id: ALICE_ASK,
    });
    expect(alice.you_give.photo_url).toBe("https://storage.test/read/alice/zelda.jpg?token=t");
    expect(alice.loop).toHaveLength(2);
    expect(alice.throw_ins).toEqual([
      {
        payer: expect.objectContaining({ user_id: ALICE }),
        payee: expect.objectContaining({ user_id: BOB }),
        amount_cents: 2000,
      },
    ]);

    const bob = await sheet(await call("GET", `/v1/deals/${DEAL}`, BOB));
    expect(bob).toMatchObject({
      you_give: { id: GALAXY },
      you_get: { id: ZELDA },
      cash: { pay_cents: 0, receive_cents: 2000 },
      fairness: { give_cents: 8500, get_cents: 4200 },
      why: "Zelda, like you asked.",
      your_ask_id: BOB_ASK,
    });
    expect(JSON.stringify(bob)).not.toContain("white whale");

    const list = DealSheetsResponse.parse(await (await call("GET", "/v1/deals", BOB)).json());
    expect(list.deals.map((d) => d.id)).toEqual([DEAL]);
  });

  it("hides Deals from outsiders and hides staged Deals from everyone", async () => {
    const { call, repo } = setup();
    for (const path of [`/v1/deals/${DEAL}`, "/v1/deals/not-a-uuid"]) {
      const res = await call("GET", path, CAROL);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    expect((await call("POST", `/v1/deals/${DEAL}/approve`, CAROL)).status).toBe(404);
    const carols = DealSheetsResponse.parse(await (await call("GET", "/v1/deals", CAROL)).json());
    expect(carols.deals).toEqual([]);

    const deal = repo.deals.find((d) => d.id === DEAL);
    if (deal) deal.status = "staged";
    expect((await call("GET", `/v1/deals/${DEAL}`)).status).toBe(404);
    expect((await call("POST", `/v1/deals/${DEAL}/approve`)).status).toBe(404);
    const alices = DealSheetsResponse.parse(await (await call("GET", "/v1/deals")).json());
    expect(alices.deals).toEqual([]);
  });

  it("approves with a snapshot, and the last approval accepts both Asks", async () => {
    const { call, sheet, repo } = setup();
    const first = await sheet(await call("POST", `/v1/deals/${DEAL}/approve`));
    expect(first).toMatchObject({ status: "pending_approvals", your_approval: "approved" });
    const snapshot = repo.dealParticipants.find((p) => p.userId === ALICE)?.snapshot;
    expect(snapshot).toMatchObject({
      id: DEAL,
      you_give: { id: ZELDA },
      cash: { pay_cents: 2000 },
    });

    const again = await call("POST", `/v1/deals/${DEAL}/approve`);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("already_decided");

    const last = await sheet(await call("POST", `/v1/deals/${DEAL}/approve`, BOB));
    expect(last.status).toBe("approved");
    expect(last.participants.map((p) => p.approval)).toEqual(["approved", "approved"]);
    expect(repo.asks.map((a) => a.status)).toEqual(["accepted", "accepted"]);
    // Items stay held for the handoff.
    expect(repo.items.filter((i) => i.reservedByDealId === DEAL)).toHaveLength(2);
  });

  it("declines: cancels, frees the Items, re-opens the Asks and remembers the Item", async () => {
    const { call, sheet, repo } = setup();
    const res = await call("POST", `/v1/deals/${DEAL}/decline`, BOB, {
      reason: " Not into Zelda ",
    });
    const declined = await sheet(res);
    expect(declined).toMatchObject({ status: "cancelled", your_approval: "declined" });
    expect(repo.dealParticipants.find((p) => p.userId === BOB)?.declineReason).toBe(
      "Not into Zelda",
    );
    expect(repo.items.filter((i) => i.reservedByDealId !== null)).toEqual([]);
    expect(repo.asks.map((a) => a.status)).toEqual(["prospecting", "prospecting"]);
    expect(repo.askExclusions).toEqual([{ askId: BOB_ASK, itemId: ZELDA }]);

    const late = await call("POST", `/v1/deals/${DEAL}/approve`);
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe("deal_closed");
    // The cancelled Deal can still be opened, but it leaves the open list.
    expect((await call("GET", `/v1/deals/${DEAL}`)).status).toBe(200);
    const list = DealSheetsResponse.parse(await (await call("GET", "/v1/deals")).json());
    expect(list.deals).toEqual([]);
  });

  it("refuses decisions on expired Deals and overlong reasons", async () => {
    const { call, repo } = setup();
    const long = await call("POST", `/v1/deals/${DEAL}/decline`, BOB, { reason: "x".repeat(201) });
    expect(long.status).toBe(400);
    const deal = repo.deals.find((d) => d.id === DEAL);
    if (deal) deal.expiresAt = new Date(Date.now() - 1000);
    const res = await call("POST", `/v1/deals/${DEAL}/approve`);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("deal_closed");
  });

  it("shows a bundle: every Item on each side, summed, and the Ask it fills first", async () => {
    const h = makeHarness();
    const KIRBY = "aaaaaaaa-0000-4000-8000-000000000002";
    const BOB_NIKE = "bbbbbbbb-0000-4000-8000-0000000000b2";
    h.repo.addItem({ id: ZELDA, ownerId: ALICE, title: "Zelda", valueMidCents: 4200 });
    h.repo.addItem({ id: KIRBY, ownerId: ALICE, title: "Kirby", valueMidCents: 6000 });
    h.repo.addItem({ id: GALAXY, ownerId: BOB, title: "Galaxy Explorer", valueMidCents: 9500 });
    h.repo.addAsk({ id: ALICE_ASK, userId: ALICE, status: "prospecting" });
    h.repo.addAsk({ id: BOB_ASK, userId: BOB, status: "prospecting" });
    h.repo.addAsk({ id: BOB_NIKE, userId: BOB, status: "prospecting" });
    // Galaxy Explorer for Zelda (Bob's game Ask) and Kirby (his other Ask).
    h.repo.addDeal({
      id: DEAL,
      legs: [
        { giverId: BOB, receiverId: ALICE, itemId: GALAXY, askId: ALICE_ASK, giverAskId: BOB_ASK },
        { giverId: ALICE, receiverId: BOB, itemId: ZELDA, askId: BOB_ASK, giverAskId: ALICE_ASK },
        { giverId: ALICE, receiverId: BOB, itemId: KIRBY, askId: BOB_NIKE, giverAskId: ALICE_ASK },
      ],
    });
    const sheetOf = async (as: string) =>
      DealSheet.parse(await (await h.request(`/v1/deals/${DEAL}`, { as })).json());

    const alice = await sheetOf(ALICE);
    expect(alice.gives.map((i) => i.id)).toEqual([KIRBY, ZELDA]);
    expect(alice.gets.map((i) => i.id)).toEqual([GALAXY]);
    expect(alice).toMatchObject({
      you_give: { id: KIRBY },
      give_to: { user_id: BOB },
      fairness: { give_cents: 10200, get_cents: 9500 },
      your_ask_id: ALICE_ASK,
    });

    // Bob's game Ask is the 1 he gives for, so its Item leads even though Kirby is worth more.
    const bob = await sheetOf(BOB);
    expect(bob.gets.map((i) => i.id)).toEqual([ZELDA, KIRBY]);
    expect(bob).toMatchObject({
      you_get: { id: ZELDA },
      get_from: { user_id: ALICE },
      fairness: { give_cents: 9500, get_cents: 10200 },
      your_ask_id: BOB_ASK,
    });
    expect(bob.loop).toHaveLength(3);
  });

  it("shows a 3-person Loop with everyone in it", async () => {
    const h = makeHarness();
    h.repo.addUser(CAROL, { displayName: "Carol" });
    for (const [id, ownerId] of [
      [ZELDA, ALICE],
      [GALAXY, BOB],
      [MARIO, CAROL],
    ] as const) {
      h.repo.addItem({
        id,
        ownerId,
        valueLowCents: 1000,
        valueMidCents: 1500,
        valueHighCents: 2000,
      });
    }
    h.repo.addDeal({
      id: DEAL,
      legs: [
        { giverId: BOB, receiverId: ALICE, itemId: GALAXY },
        { giverId: CAROL, receiverId: BOB, itemId: MARIO },
        { giverId: ALICE, receiverId: CAROL, itemId: ZELDA },
      ],
    });
    const carol = DealSheet.parse(
      await (await h.request(`/v1/deals/${DEAL}`, { as: CAROL })).json(),
    );
    expect(carol).toMatchObject({
      you_give: { id: MARIO },
      give_to: { user_id: BOB },
      you_get: { id: ZELDA },
      get_from: { user_id: ALICE },
      cash: { pay_cents: 0, receive_cents: 0 },
    });
    expect(carol.participants.map((p) => p.first_name)).toEqual(["Alice", "Bob", "Carol"]);
    expect(carol.loop).toHaveLength(3);
  });
});
