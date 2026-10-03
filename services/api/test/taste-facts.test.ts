import { TasteFactsResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const FALCON = "ffffffff-0000-4000-8000-000000000001";
const LEGO = "ffffffff-0000-4000-8000-000000000002";
const SPOT = "ffffffff-0000-4000-8000-000000000003";
const OLD = "ffffffff-0000-4000-8000-000000000004";
const BOBS = "ffffffff-0000-4000-8000-000000000005";

function setup() {
  const h = makeHarness();
  h.repo.addTasteFact({
    id: FALCON,
    userId: ALICE,
    key: "never_trade",
    value: "Millennium Falcon",
    category: "limits",
    source: "intake",
    alwaysOn: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  });
  h.repo.addTasteFact({
    id: LEGO,
    userId: ALICE,
    key: "hunting_for",
    value: "Star Wars UCS sets",
    category: "hunting",
    source: "chat",
    createdAt: new Date("2026-10-02T00:00:00Z"),
  });
  h.repo.addTasteFact({
    id: SPOT,
    userId: ALICE,
    key: "handoff_note",
    value: "Prefers weekend handoffs",
    category: "preferences",
    source: "shelf_edits",
    createdAt: new Date("2026-10-03T00:00:00Z"),
  });
  h.repo.addTasteFact({ id: OLD, userId: ALICE, status: "superseded" });
  h.repo.addTasteFact({ id: BOBS, userId: BOB, value: "Bob's secret" });
  return h;
}

describe("GET /v1/me/taste-facts", () => {
  it("lists active facts, always-on first, with human source labels", async () => {
    const { request } = setup();
    const res = await request("/v1/me/taste-facts", { as: ALICE });
    expect(res.status).toBe(200);
    const body = TasteFactsResponse.parse(await res.json());
    expect(body.facts).toEqual([
      {
        id: FALCON,
        key: "never_trade",
        value: "Millennium Falcon",
        category: "limits",
        source: "Intake chat",
        always_on: true,
        created_at: "2026-10-01T00:00:00.000Z",
      },
      expect.objectContaining({ id: SPOT, source: "Shelf edits" }),
      expect.objectContaining({ id: LEGO, source: "Chat" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("Bob's secret");
  });

  it("requires auth", async () => {
    const { request } = setup();
    expect((await request("/v1/me/taste-facts")).status).toBe(401);
  });

  it("leaves /v1/me alone", async () => {
    const { request } = setup();
    expect((await request("/v1/me", { as: ALICE })).status).toBe(200);
  });
});

describe("DELETE /v1/me/taste-facts/:id", () => {
  it("marks the fact deleted so it no longer lists", async () => {
    const { request, repo } = setup();
    const res = await request(`/v1/me/taste-facts/${FALCON}`, { method: "DELETE", as: ALICE });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(repo.tasteFacts.find((f) => f.id === FALCON)?.status).toBe("deleted");
    const body = TasteFactsResponse.parse(
      await (await request("/v1/me/taste-facts", { as: ALICE })).json(),
    );
    expect(body.facts.map((f) => f.id)).not.toContain(FALCON);
  });

  it("is a 404 for someone else's fact, a missing one and a malformed ID", async () => {
    const { request, repo } = setup();
    for (const id of [BOBS, "ffffffff-0000-4000-8000-00000000000f", "nope"]) {
      const res = await request(`/v1/me/taste-facts/${id}`, { method: "DELETE", as: ALICE });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    expect(repo.tasteFacts.find((f) => f.id === BOBS)?.status).toBe("active");
  });

  it("replays a retried delete with the same Idempotency-Key", async () => {
    const { request } = setup();
    const init = {
      method: "DELETE",
      as: ALICE,
      headers: { "Idempotency-Key": "delete-fact-0001" },
    };
    expect((await request(`/v1/me/taste-facts/${LEGO}`, init)).status).toBe(204);
    const again = await request(`/v1/me/taste-facts/${LEGO}`, init);
    expect(again.status).toBe(204);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
  });
});
