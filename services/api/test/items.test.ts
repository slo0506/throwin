import { ShelfResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, makeHarness } from "./helpers.js";

describe("GET /v1/items", () => {
  it("returns an empty Shelf for a new user", async () => {
    const { request } = makeHarness();
    const res = await request("/v1/items", { as: ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("returns only the caller's Shelf items, newest first, with value ranges", async () => {
    const { request, repo } = makeHarness();
    repo.addItem({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      ownerId: ALICE,
      category: "toys/lego",
      brand: "LEGO",
      model: "76240 Batmobile Tumbler",
      variant: "2021 release",
      conditionGrade: "B",
      defects: ["box corner crushed"],
      valueLowCents: 18000,
      valueMidCents: 21500,
      valueHighCents: 25000,
      identityConf: 0.86,
      conditionConf: 0.62,
      reservedByDealId: "dddddddd-0000-4000-8000-000000000001",
      status: "reserved",
      createdAt: new Date("2026-10-01T00:00:00Z"),
    });
    repo.addItem({
      id: "aaaaaaaa-0000-4000-8000-000000000002",
      ownerId: ALICE,
      status: "draft",
      createdAt: new Date("2026-10-02T00:00:00Z"),
    });
    repo.addItem({ id: "aaaaaaaa-0000-4000-8000-000000000003", ownerId: ALICE, status: "removed" });
    repo.addItem({ id: "bbbbbbbb-0000-4000-8000-000000000001", ownerId: BOB });

    const res = await request("/v1/items", { as: ALICE });
    const body = ShelfResponse.parse(await res.json());
    expect(body.items.map((i) => i.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000001",
    ]);
    const [draft, lego] = body.items;
    expect(draft?.value).toBeNull();
    expect(lego).toMatchObject({
      status: "reserved",
      is_reserved: true,
      condition_grade: "B",
      value: { low_cents: 18000, mid_cents: 21500, high_cents: 25000, currency: "USD" },
    });
    expect(JSON.stringify(body)).not.toContain("dddddddd");
  });

  it("requires auth", async () => {
    const { request } = makeHarness();
    expect((await request("/v1/items")).status).toBe(401);
  });
});
