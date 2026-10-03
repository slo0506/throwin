import { DEFAULT_NOTIFICATION_PREFS, Me } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

describe("GET /v1/me", () => {
  it("returns the caller's profile and counts", async () => {
    const { request, repo } = makeHarness();
    repo.addItem({ id: "6f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e5f", ownerId: ALICE });
    repo.addItem({ id: "7f1c1c5e-6a8a-4b7a-9f0e-2a0d1c3b4e5f", ownerId: BOB });
    repo.asks.push(
      { userId: ALICE, status: "prospecting" },
      { userId: ALICE, status: "fulfilled" },
    );
    repo.memberships.push({ userId: ALICE, circleId: "c1" });

    const res = await request("/v1/me", { as: ALICE });
    expect(res.status).toBe(200);
    const body = Me.parse(await res.json());
    expect(body).toEqual({
      id: ALICE,
      display_name: "Alice",
      photo_url: null,
      created_at: "2026-10-03T00:00:00.000Z",
      profile: {
        autonomy_level: "every_deal",
        notification_prefs: DEFAULT_NOTIFICATION_PREFS,
        home_area: null,
        default_handoff_place_id: null,
      },
      counts: { shelf_items: 1, active_asks: 1, circles: 1 },
    });
  });

  it("returns 404 when the user row is missing", async () => {
    const { request } = makeHarness();
    const res = await request("/v1/me", { as: "33333333-3333-4333-8333-333333333333" });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("user_not_found");
  });
});

describe("PATCH /v1/me", () => {
  it("updates profile fields and merges notification prefs", async () => {
    const { request } = makeHarness();
    const res = await request("/v1/me", {
      as: ALICE,
      method: "PATCH",
      body: JSON.stringify({
        display_name: " Ally ",
        photo_url: "https://cdn.example.com/a.jpg",
        autonomy_level: "likely_accept",
        notification_prefs: { promotional: true },
      }),
    });
    expect(res.status).toBe(200);
    const body = Me.parse(await res.json());
    expect(body.display_name).toBe("Ally");
    expect(body.photo_url).toBe("https://cdn.example.com/a.jpg");
    expect(body.profile.autonomy_level).toBe("likely_accept");
    expect(body.profile.notification_prefs).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      promotional: true,
    });
  });

  it("rejects invalid bodies with 400", async () => {
    const { request } = makeHarness();
    for (const body of ["{", "{}", '{"autonomy_level":"auto_execute"}', '{"email":"x@y.z"}']) {
      const res = await request("/v1/me", { as: ALICE, method: "PATCH", body });
      expect(res.status, body).toBe(400);
      expect(["invalid_json", "validation_error"]).toContain(await errorCode(res));
    }
  });

  it("only changes the caller", async () => {
    const { request } = makeHarness();
    await request("/v1/me", { as: ALICE, method: "PATCH", body: '{"display_name":"Zed"}' });
    const bob = Me.parse(await (await request("/v1/me", { as: BOB })).json());
    expect(bob.display_name).toBe("Bob");
  });
});

describe("DELETE /v1/me", () => {
  it("soft deletes and schedules a hard delete 30 days out", async () => {
    const { request, repo } = makeHarness();
    const res = await request("/v1/me", { as: ALICE, method: "DELETE" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: "scheduled",
      hard_delete_after: "2026-11-02T12:00:00.000Z",
    });
    expect(repo.users.get(ALICE)?.deletedAt?.toISOString()).toBe("2026-10-03T12:00:00.000Z");

    const after = await request("/v1/me", { as: ALICE });
    expect(after.status).toBe(410);
    expect(await errorCode(after)).toBe("account_deleted");
  });

  it("is safe to repeat", async () => {
    const { request } = makeHarness();
    const first = await (await request("/v1/me", { as: ALICE, method: "DELETE" })).json();
    const second = await request("/v1/me", { as: ALICE, method: "DELETE" });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(first);
  });
});
