import { Ask, AsksResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const LEGO = "aaaaaaaa-0000-4000-8000-000000000001";
const ZELDA = "aaaaaaaa-0000-4000-8000-000000000002";
const DRAFT = "aaaaaaaa-0000-4000-8000-000000000003";
const HELD = "aaaaaaaa-0000-4000-8000-000000000004";
const UNPRICED = "aaaaaaaa-0000-4000-8000-000000000005";
const BOBS = "bbbbbbbb-0000-4000-8000-000000000001";

const TARGET = {
  kind: "exact",
  name: "LEGO Batman Batmobile Tumbler 76240",
  brand: "LEGO",
  model: "76240",
  category: "toys/lego",
  constraints: ["built is fine"],
  anchor: { retail_cents: 26999, used_low_cents: 18000, used_high_cents: 25000 },
};

function setup() {
  const h = makeHarness();
  h.repo.addItem({
    id: LEGO,
    ownerId: ALICE,
    valueLowCents: 18000,
    valueMidCents: 21000,
    valueHighCents: 25000,
  });
  h.repo.addItem({
    id: ZELDA,
    ownerId: ALICE,
    valueLowCents: 3500,
    valueMidCents: 4200,
    valueHighCents: 5000,
  });
  h.repo.addItem({ id: DRAFT, ownerId: ALICE, status: "draft" });
  h.repo.addItem({
    id: HELD,
    ownerId: ALICE,
    status: "reserved",
    reservedByDealId: "dddddddd-0000-4000-8000-000000000001",
  });
  h.repo.addItem({ id: UNPRICED, ownerId: ALICE });
  h.repo.addItem({
    id: BOBS,
    ownerId: BOB,
    valueLowCents: 100,
    valueMidCents: 200,
    valueHighCents: 300,
  });
  const json = (body: unknown) => ({ body: JSON.stringify(body) });
  const post = (body: unknown, as = ALICE) =>
    h.request("/v1/asks", { method: "POST", as, ...json(body) });
  const patch = (id: string, body: unknown, as = ALICE) =>
    h.request(`/v1/asks/${id}`, { method: "PATCH", as, ...json(body) });
  const create = async (body: unknown = { raw_text: "the big Lego Batmobile" }) => {
    const res = await post(body);
    expect(res.status).toBe(201);
    return Ask.parse(await res.json());
  };
  return { ...h, post, patch, create };
}

describe("POST /v1/asks", () => {
  it("creates a drafting Ask from plain words", async () => {
    const { create } = setup();
    const ask = await create();
    expect(ask).toMatchObject({
      raw_text: "the big Lego Batmobile",
      title: null,
      status: "drafting",
      status_line: "Pinning down what you want",
      target: null,
      offer_item_ids: [],
      offer_value: { low_cents: 0, high_cents: 0 },
      cash_ceiling_cents: 0,
      autonomy: "every_deal",
      deadline: null,
    });
  });

  it("starts at offering with a resolved target, titled from it", async () => {
    const { create } = setup();
    const ask = await create({
      raw_text: "the big Lego Batmobile",
      target: TARGET,
      cash_ceiling_cents: 2000,
      autonomy: "likely_yes",
    });
    expect(ask).toMatchObject({
      title: "LEGO Batman Batmobile Tumbler 76240",
      status: "offering",
      status_line: "Waiting for what you'd offer",
      target: TARGET,
      cash_ceiling_cents: 2000,
      autonomy: "likely_yes",
    });
  });

  it("fills target defaults", async () => {
    const { create } = setup();
    const ask = await create({
      raw_text: "a Switch game",
      target: { kind: "category", name: "Switch games" },
    });
    expect(ask.target).toEqual({
      kind: "category",
      name: "Switch games",
      brand: null,
      model: null,
      category: null,
      constraints: [],
      anchor: null,
    });
  });

  it("rejects bad bodies", async () => {
    const { post } = setup();
    for (const body of [
      {},
      { raw_text: "   " },
      { raw_text: "x".repeat(501) },
      { raw_text: "x", cash_ceiling_cents: 100001 },
      { raw_text: "x", cash_ceiling_cents: 12.5 },
      { raw_text: "x", status: "prospecting" },
      { raw_text: "x", autonomy: "yolo" },
      { raw_text: "x", target: { kind: "exact" } },
      { raw_text: "x", target: { ...TARGET, anchor: { used_low_cents: 5, used_high_cents: 1 } } },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe("validation_error");
    }
  });

  it("requires auth", async () => {
    const { request } = setup();
    expect((await request("/v1/asks", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("GET /v1/asks", () => {
  it("lists the caller's Asks newest first, without cancelled ones", async () => {
    const { create, patch, request } = setup();
    const first = await create({ raw_text: "first" });
    const second = await create({ raw_text: "second" });
    const third = await create({ raw_text: "third" });
    await patch(second.id, { status: "cancelled" });
    const res = await request("/v1/asks", { as: ALICE });
    const body = AsksResponse.parse(await res.json());
    expect(body.asks.map((a) => a.id)).toEqual([third.id, first.id]);
    const bobs = AsksResponse.parse(await (await request("/v1/asks", { as: BOB })).json());
    expect(bobs.asks).toEqual([]);
  });
});

describe("GET /v1/asks/:id", () => {
  it("returns the owner's Ask, cancelled ones included", async () => {
    const { create, patch, request } = setup();
    const ask = await create();
    await patch(ask.id, { status: "cancelled" });
    const res = await request(`/v1/asks/${ask.id}`, { as: ALICE });
    expect(res.status).toBe(200);
    expect(Ask.parse(await res.json())).toMatchObject({
      status: "cancelled",
      status_line: "Cancelled",
    });
  });

  it("is a 404 for someone else's Ask, a missing one and a malformed ID", async () => {
    const { create, request } = setup();
    const ask = await create({ raw_text: "x", cash_ceiling_cents: 4200 });
    for (const [id, as] of [
      [ask.id, BOB],
      ["cccccccc-0000-4000-8000-000000000001", ALICE],
      ["not-a-uuid", ALICE],
    ] as const) {
      const res = await request(`/v1/asks/${id}`, { as });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("4200");
    }
  });
});

describe("PATCH /v1/asks/:id", () => {
  it("moves offering to prospecting with an offer set and sums its value range", async () => {
    const { create, patch } = setup();
    const ask = await create({ raw_text: "Batmobile", target: TARGET });
    const res = await patch(ask.id, { offer_item_ids: [LEGO, ZELDA.toUpperCase(), LEGO] });
    expect(res.status).toBe(200);
    const body = Ask.parse(await res.json());
    expect(body).toMatchObject({
      status: "prospecting",
      status_line: "Looking through your Circles",
      offer_value: { low_cents: 21500, high_cents: 30000 },
    });
    expect([...body.offer_item_ids].sort()).toEqual([LEGO, ZELDA]);
  });

  it("moves drafting to prospecting with an offer set", async () => {
    const { create, patch } = setup();
    const ask = await create();
    const body = Ask.parse(await (await patch(ask.id, { offer_item_ids: [ZELDA] })).json());
    expect(body.status).toBe("prospecting");
  });

  it("moves drafting to offering when the target resolves, and sets the title", async () => {
    const { create, patch } = setup();
    const ask = await create();
    const body = Ask.parse(await (await patch(ask.id, { target: TARGET })).json());
    expect(body).toMatchObject({ status: "offering", title: TARGET.name, target: TARGET });
  });

  it("keeps the status for an empty offer set", async () => {
    const { create, patch } = setup();
    const ask = await create({ raw_text: "Batmobile", target: TARGET });
    const body = Ask.parse(await (await patch(ask.id, { offer_item_ids: [] })).json());
    expect(body.status).toBe("offering");
  });

  it("counts an unpriced Item as adding nothing yet", async () => {
    const { create, patch } = setup();
    const ask = await create();
    const body = Ask.parse(
      await (await patch(ask.id, { offer_item_ids: [ZELDA, UNPRICED] })).json(),
    );
    expect(body.offer_value).toEqual({ low_cents: 3500, high_cents: 5000 });
    expect(body.offer_item_ids).toHaveLength(2);
  });

  it("drops removed Items from the offer set it shows", async () => {
    const { create, patch, request, repo } = setup();
    const ask = await create();
    await patch(ask.id, { offer_item_ids: [ZELDA, LEGO] });
    await repo.removeItem(ALICE, LEGO);
    const body = Ask.parse(await (await request(`/v1/asks/${ask.id}`, { as: ALICE })).json());
    expect(body.offer_item_ids).toEqual([ZELDA]);
    expect(body.offer_value).toEqual({ low_cents: 3500, high_cents: 5000 });
  });

  it("refuses offer Items that are not the owner's, not on the Shelf, or reserved", async () => {
    const { create, patch, request } = setup();
    const ask = await create();
    for (const ids of [
      [BOBS],
      [DRAFT],
      [HELD],
      [ZELDA, BOBS],
      ["cccccccc-0000-4000-8000-000000000009"],
    ]) {
      const res = await patch(ask.id, { offer_item_ids: ids, raw_text: "changed" });
      expect(res.status, ids.join()).toBe(400);
      expect(await errorCode(res)).toBe("invalid_offer_item");
    }
    const after = Ask.parse(await (await request(`/v1/asks/${ask.id}`, { as: ALICE })).json());
    expect(after).toMatchObject({
      raw_text: "the big Lego Batmobile",
      status: "drafting",
      offer_item_ids: [],
    });
  });

  it("updates the simple fields, and clears the deadline with null", async () => {
    const { create, patch } = setup();
    const ask = await create();
    const set = Ask.parse(
      await (
        await patch(ask.id, {
          raw_text: "the 2021 Tumbler",
          cash_ceiling_cents: 100000,
          autonomy: "likely_yes",
          deadline: "2026-10-20T00:00:00Z",
        })
      ).json(),
    );
    expect(set).toMatchObject({
      raw_text: "the 2021 Tumbler",
      cash_ceiling_cents: 100000,
      autonomy: "likely_yes",
      deadline: "2026-10-20T00:00:00.000Z",
    });
    const cleared = Ask.parse(await (await patch(ask.id, { deadline: null })).json());
    expect(cleared.deadline).toBeNull();
  });

  it("only accepts cancelled as a status, and a cancelled Ask is closed", async () => {
    const { create, patch } = setup();
    const ask = await create();
    for (const status of ["prospecting", "fulfilled", "accepted"]) {
      const res = await patch(ask.id, { status });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("validation_error");
    }
    const cancelled = await patch(ask.id, { status: "cancelled" });
    expect(Ask.parse(await cancelled.json()).status).toBe("cancelled");
    expect((await patch(ask.id, { status: "cancelled" })).status).toBe(200);
    const edit = await patch(ask.id, { raw_text: "never mind" });
    expect(edit.status).toBe(409);
    expect(await errorCode(edit)).toBe("ask_closed");
  });

  it("rejects bad bodies", async () => {
    const { create, patch } = setup();
    const ask = await create();
    for (const body of [
      {},
      { cash_ceiling_cents: -1 },
      { cash_ceiling_cents: 100001 },
      { offer_item_ids: ["nope"] },
      {
        offer_item_ids: Array.from(
          { length: 21 },
          (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      },
      { deadline: "tomorrow" },
      { user_id: BOB },
    ]) {
      const res = await patch(ask.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("is a 404 for someone else's Ask", async () => {
    const { create, patch, repo } = setup();
    const ask = await create();
    const res = await patch(ask.id, { status: "cancelled" }, BOB);
    expect(res.status).toBe(404);
    expect((await repo.getAsk(ALICE, ask.id))?.status).toBe("drafting");
    expect((await patch("not-a-uuid", { status: "cancelled" })).status).toBe(404);
  });

  it("replays with the same Idempotency-Key", async () => {
    const { create, request } = setup();
    const ask = await create();
    const init = {
      method: "PATCH",
      as: ALICE,
      headers: { "Idempotency-Key": "patch-ask-0001" },
      body: JSON.stringify({ offer_item_ids: [ZELDA] }),
    };
    const first = await request(`/v1/asks/${ask.id}`, init);
    const again = await request(`/v1/asks/${ask.id}`, init);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
  });
});
