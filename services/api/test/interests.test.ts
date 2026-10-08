import { InterestsResponse, NextUpResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const ASK = "aaaaaaaa-0000-4000-8000-0000000000b1";
const ZELDA = "bbbbbbbb-0000-4000-8000-000000000011";
const GALAXY = "bbbbbbbb-0000-4000-8000-000000000012";
const KEPT = "bbbbbbbb-0000-4000-8000-000000000013";
const N = "eeeeeeee-0000-4000-8000-000000000011";

// Alice wants a Switch game and offers her Galaxy Explorer for it; Bob's Zelda is on his
// Shelf, offered for nothing.
function setup() {
  const h = makeHarness();
  h.repo.addItem({ id: ZELDA, ownerId: BOB, title: "Zelda: Tears of the Kingdom" });
  h.repo.addItem({ id: GALAXY, ownerId: ALICE, title: "LEGO Galaxy Explorer" });
  h.repo.addItem({ id: KEPT, ownerId: ALICE, title: "Not on offer" });
  h.repo.addAsk({
    id: ASK,
    userId: ALICE,
    status: "prospecting",
    title: "a Switch game",
    offerItemIds: [GALAXY],
  });
  h.repo.interests.push({
    id: N,
    askId: ASK,
    wanterId: ALICE,
    itemId: ZELDA,
    ownerId: BOB,
    status: "pending",
    expiresAt: new Date(Date.now() + 40 * 3_600_000),
  });
  const answer = (body: object, as = BOB) =>
    h.request(`/v1/interests/${N}/answer`, { method: "POST", as, body: JSON.stringify(body) });
  return { ...h, answer };
}

describe("interests", () => {
  it("shows the owner who's looking and what they offer, never their limits", async () => {
    const h = setup();
    const body = InterestsResponse.parse(
      await (await h.request("/v1/interests", { as: BOB })).json(),
    );
    expect(body.interests).toEqual([
      expect.objectContaining({
        id: N,
        ask_title: "a Switch game",
        item: expect.objectContaining({ id: ZELDA }),
        their_offer: [expect.objectContaining({ id: GALAXY, title: "LEGO Galaxy Explorer" })],
      }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/ceiling|cash/);
    const alice = InterestsResponse.parse(
      await (await h.request("/v1/interests", { as: ALICE })).json(),
    );
    expect(alice.interests).toEqual([]);

    const next = NextUpResponse.parse(await (await h.request("/v1/next-up", { as: BOB })).json());
    expect(next.items.find((i) => i.kind === "someone_wants")).toMatchObject({
      id: `interest:${N}`,
      cta: "See trade",
      item_id: ZELDA,
    });
  });

  it("yes with 1 of their offered Items makes the owner an Ask and starts matching", async () => {
    const h = setup();
    expect((await h.answer({ answer: "yes", want_item_id: GALAXY }, ALICE)).status).toBe(404);
    expect((await h.answer({ answer: "yes" })).status).toBe(400);
    const off = await h.answer({ answer: "yes", want_item_id: KEPT });
    expect(off.status).toBe(409);
    expect(await errorCode(off)).toBe("interest_changed");
    expect((await h.answer({ answer: "yes", want_item_id: GALAXY })).status).toBe(200);
    const made = h.repo.asks.find((a) => a.userId === BOB);
    expect(made).toMatchObject({
      status: "prospecting",
      title: "LEGO Galaxy Explorer",
      offerItemIds: [ZELDA],
    });
    expect(h.repo.jobs).toContainEqual({
      kind: "prospect_ask",
      payload: { ask_id: made?.id, user_id: BOB },
    });
    const again = await h.answer({ answer: "no" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("interest_closed");
  });

  it("no keeps the Item away from that Ask", async () => {
    const h = setup();
    expect((await h.answer({ answer: "no" })).status).toBe(200);
    expect(h.repo.askExclusions).toContainEqual({ askId: ASK, itemId: ZELDA });
  });
});
