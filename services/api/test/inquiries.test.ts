import { InquiriesResponse, NextUpResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const ASK = "aaaaaaaa-0000-4000-8000-0000000000a1";
const PS5 = "bbbbbbbb-0000-4000-8000-000000000001";
const Q = "eeeeeeee-0000-4000-8000-000000000001";

function setup() {
  const h = makeHarness();
  h.repo.addAsk({ id: ASK, userId: ALICE, status: "prospecting", title: "Xbox Series X" });
  h.repo.addItem({
    id: PS5,
    ownerId: BOB,
    title: "PlayStation 5 Slim, 1TB",
    valueLowCents: 30000,
    valueMidCents: 34000,
    valueHighCents: 38000,
  });
  h.repo.inquiries.push({
    id: Q,
    askId: ASK,
    userId: ALICE,
    itemId: PS5,
    status: "pending",
    expiresAt: new Date(Date.now() + 20 * 3_600_000),
  });
  const answer = (answer: string, as = ALICE, id = Q) =>
    h.request(`/v1/inquiries/${id}/answer`, {
      method: "POST",
      as,
      body: JSON.stringify({ answer }),
    });
  return { ...h, answer };
}

describe("inquiries", () => {
  it("shows the person asked the Item and their Ask, never who has it", async () => {
    const h = setup();
    const body = InquiriesResponse.parse(
      await (await h.request("/v1/inquiries", { as: ALICE })).json(),
    );
    expect(body.inquiries).toEqual([
      expect.objectContaining({
        id: Q,
        ask_id: ASK,
        ask_title: "Xbox Series X",
        item: expect.objectContaining({ id: PS5, title: "PlayStation 5 Slim, 1TB" }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Bob|user_id/);
    const bob = InquiriesResponse.parse(
      await (await h.request("/v1/inquiries", { as: BOB })).json(),
    );
    expect(bob.inquiries).toEqual([]);

    const next = NextUpResponse.parse(await (await h.request("/v1/next-up", { as: ALICE })).json());
    expect(next.items.find((i) => i.kind === "answer_inquiry")).toMatchObject({
      id: `inquiry:${Q}`,
      title: "Would PlayStation 5 Slim work for your Xbox Series X?",
      cta: "Answer",
      ask_id: ASK,
      item_id: PS5,
    });
  });

  it("yes re-matches the Ask; it's answered once, and only by the person asked", async () => {
    const h = setup();
    expect((await h.answer("yes", BOB)).status).toBe(404);
    expect((await h.answer("maybe")).status).toBe(400);
    expect((await h.answer("yes")).status).toBe(200);
    expect(h.repo.jobs).toContainEqual({
      kind: "prospect_ask",
      payload: { ask_id: ASK, user_id: ALICE },
    });
    const again = await h.answer("no");
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("inquiry_closed");
    const left = InquiriesResponse.parse(
      await (await h.request("/v1/inquiries", { as: ALICE })).json(),
    );
    expect(left.inquiries).toEqual([]);
  });

  it("no keeps the Item away from that Ask", async () => {
    const h = setup();
    expect((await h.answer("no")).status).toBe(200);
    expect(h.repo.askExclusions).toContainEqual({ askId: ASK, itemId: PS5 });
  });
});
