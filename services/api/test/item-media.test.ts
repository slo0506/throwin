import { ItemMediaUploadResponse, ShelfItem } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const ITEM = "aaaaaaaa-0000-4000-8000-0000000000a1";
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers,
});

function withSneaker(h: ReturnType<typeof makeHarness>) {
  return h.repo.addItem({
    id: ITEM,
    ownerId: ALICE,
    status: "needs_photos",
    title: "Air Jordan 1 Mid",
    followUp: "Photo of the size tag",
    thumbnailPath: `${ALICE}/c/crops/0.jpg`,
  });
}

describe("GET /v1/items/:id", () => {
  it("returns the caller's Item with is_appraising", async () => {
    const h = makeHarness();
    withSneaker(h).appraising = true;
    const res = await h.request(`/v1/items/${ITEM}`, { as: ALICE });
    expect(res.status).toBe(200);
    const item = ShelfItem.parse(await res.json());
    expect(item).toMatchObject({
      id: ITEM,
      is_appraising: true,
      follow_up: "Photo of the size tag",
    });
    expect(item.thumbnail_url).toContain(`${ALICE}/c/crops/0.jpg`);
  });

  it("is a 404 for someone else's, removed or malformed Items", async () => {
    const h = makeHarness();
    withSneaker(h);
    const asBob = await h.request(`/v1/items/${ITEM}`, { as: BOB });
    expect(asBob.status).toBe(404);
    expect(await errorCode(asBob)).toBe("not_found");
    expect((await h.request("/v1/items/not-a-uuid", { as: ALICE })).status).toBe(404);
    (h.repo.items[0] as { status: string }).status = "removed";
    expect((await h.request(`/v1/items/${ITEM}`, { as: ALICE })).status).toBe(404);
  });

  it("projects is_appraising on the Shelf too", async () => {
    const h = makeHarness();
    withSneaker(h);
    const body = await (await h.request("/v1/items", { as: ALICE })).json();
    expect(body.items[0].is_appraising).toBe(false);
  });
});

describe("POST /v1/items/:id/media/uploads", () => {
  it("returns 1 signed upload per photo in the Item's folder", async () => {
    const h = makeHarness();
    withSneaker(h);
    const res = await h.request(`/v1/items/${ITEM}/media/uploads`, {
      ...post({ count: 2 }),
      as: ALICE,
    });
    expect(res.status).toBe(201);
    const body = ItemMediaUploadResponse.parse(await res.json());
    expect(body.uploads).toHaveLength(2);
    for (const u of body.uploads) {
      expect(u.path).toMatch(new RegExp(`^${ALICE}/items/${ITEM}/[0-9a-f-]{36}\\.jpg$`));
    }
    expect(new Set(body.uploads.map((u) => u.path)).size).toBe(2);
  });

  it("caps at 5 photos and hides other users' Items", async () => {
    const h = makeHarness();
    withSneaker(h);
    const tooMany = await h.request(`/v1/items/${ITEM}/media/uploads`, {
      ...post({ count: 6 }),
      as: ALICE,
    });
    expect(tooMany.status).toBe(400);
    const asBob = await h.request(`/v1/items/${ITEM}/media/uploads`, {
      ...post({ count: 1 }),
      as: BOB,
    });
    expect(asBob.status).toBe(404);
    expect(h.media.uploads).toHaveLength(0);
  });
});

describe("POST /v1/items/:id/media", () => {
  const photo = (name = "a") => ({ path: `${ALICE}/items/${ITEM}/${name}.jpg`, width: 1000 });

  it("records photos, flags the Item and enqueues reappraise_item", async () => {
    const h = makeHarness();
    withSneaker(h);
    const res = await h.request(`/v1/items/${ITEM}/media`, {
      ...post({ media: [photo("a"), photo("b")] }),
      as: ALICE,
    });
    expect(res.status).toBe(202);
    const item = ShelfItem.parse(await res.json());
    expect(item.is_appraising).toBe(true);
    expect(h.repo.itemMedia.map((m) => m.path)).toEqual([photo("a").path, photo("b").path]);
    expect(h.repo.jobs).toEqual([
      { kind: "reappraise_item", payload: { item_id: ITEM, user_id: ALICE } },
    ]);
  });

  it("refuses paths outside the Item's folder", async () => {
    const h = makeHarness();
    withSneaker(h);
    for (const path of [
      `${BOB}/items/${ITEM}/a.jpg`,
      `${ALICE}/items/aaaaaaaa-0000-4000-8000-0000000000a2/a.jpg`,
      `${ALICE}/items/${ITEM}/../../c/0.jpg`,
    ]) {
      const res = await h.request(`/v1/items/${ITEM}/media`, {
        ...post({ media: [{ path }] }),
        as: ALICE,
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_media_path");
    }
    expect(h.repo.jobs).toHaveLength(0);
  });

  it("is a 409 conflict while appraising or reserved, and a 404 for others", async () => {
    const h = makeHarness();
    withSneaker(h);
    const first = await h.request(`/v1/items/${ITEM}/media`, {
      ...post({ media: [photo()] }),
      as: ALICE,
    });
    expect(first.status).toBe(202);
    const again = await h.request(`/v1/items/${ITEM}/media`, {
      ...post({ media: [photo("b")] }),
      as: ALICE,
    });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("conflict");

    const reserved = "aaaaaaaa-0000-4000-8000-0000000000a3";
    h.repo.addItem({ id: reserved, ownerId: ALICE, status: "reserved", reservedByDealId: "d1" });
    const held = await h.request(`/v1/items/${reserved}/media`, {
      ...post({ media: [{ path: `${ALICE}/items/${reserved}/a.jpg` }] }),
      as: ALICE,
    });
    expect(held.status).toBe(409);

    const asBob = await h.request(`/v1/items/${ITEM}/media`, {
      ...post({ media: [{ path: `${BOB}/items/${ITEM}/a.jpg` }] }),
      as: BOB,
    });
    expect(asBob.status).toBe(404);
    expect(await errorCode(asBob)).toBe("not_found");
  });

  it("replays with the same Idempotency-Key instead of enqueueing twice", async () => {
    const h = makeHarness();
    withSneaker(h);
    const init = { ...post({ media: [photo()] }, { "Idempotency-Key": "follow-up-0001" }) };
    const a = await h.request(`/v1/items/${ITEM}/media`, { ...init, as: ALICE });
    const b = await h.request(`/v1/items/${ITEM}/media`, { ...init, as: ALICE });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(h.repo.jobs).toHaveLength(1);
  });
});
