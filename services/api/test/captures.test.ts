import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

async function openCapture(h: ReturnType<typeof makeHarness>, count = 2) {
  const res = await h.request("/v1/media/uploads", { ...post({ count }), as: ALICE });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    capture_id: string;
    uploads: { path: string; upload_url: string }[];
  };
}

describe("POST /v1/media/uploads", () => {
  it("opens a capture with 1 signed upload per file under the caller's folder", async () => {
    const h = makeHarness();
    const body = await openCapture(h, 3);
    expect(body.uploads).toHaveLength(3);
    expect(body.uploads[0]?.path).toBe(`${ALICE}/${body.capture_id}/0.jpg`);
    expect(body.uploads[0]?.upload_url).toContain("https://storage.test/upload/");
    expect(h.repo.captures[0]?.status).toBe("uploading");
  });

  it("caps a capture at 30 files", async () => {
    const h = makeHarness();
    const res = await h.request("/v1/media/uploads", { ...post({ count: 31 }), as: ALICE });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/captures", () => {
  it("submits media and enqueues the Appraiser", async () => {
    const h = makeHarness();
    const { capture_id, uploads } = await openCapture(h);
    const res = await h.request("/v1/captures", {
      ...post({
        capture_id,
        media: uploads.map((u) => ({ path: u.path, width: 1000, height: 750, sharpness: 40 })),
      }),
      as: ALICE,
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("processing");
    expect(body.media_count).toBe(2);
    expect(h.repo.jobs).toEqual([
      { kind: "appraise_capture", payload: { capture_id, user_id: ALICE } },
    ]);
  });

  it("refuses paths outside the capture", async () => {
    const h = makeHarness();
    const { capture_id } = await openCapture(h);
    const res = await h.request("/v1/captures", {
      ...post({ capture_id, media: [{ path: `${BOB}/${capture_id}/0.jpg` }] }),
      as: ALICE,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_media_path");
  });

  it("refuses another user's capture and double submits", async () => {
    const h = makeHarness();
    const { capture_id, uploads } = await openCapture(h);
    const media = uploads.map((u) => ({ path: u.path }));

    const asBob = await h.request("/v1/captures", {
      ...post({ capture_id, media: [{ path: `${BOB}/${capture_id}/0.jpg` }] }),
      as: BOB,
    });
    expect(asBob.status).toBe(404);

    expect(
      (await h.request("/v1/captures", { ...post({ capture_id, media }), as: ALICE })).status,
    ).toBe(202);
    const again = await h.request("/v1/captures", { ...post({ capture_id, media }), as: ALICE });
    expect(again.status).toBe(409);
  });
});

describe("GET /v1/captures/:id", () => {
  it("returns progress and the Items found so far with thumbnails", async () => {
    const h = makeHarness();
    const { capture_id } = await openCapture(h);
    h.repo.addItem({
      id: "i1",
      ownerId: ALICE,
      captureId: capture_id,
      title: "LEGO Typewriter",
      thumbnailPath: "p/crop.jpg",
    });
    const res = await h.request(`/v1/captures/${capture_id}`, { as: ALICE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].thumbnail_url).toBe("https://storage.test/read/p/crop.jpg?token=t");
    expect((await h.request(`/v1/captures/${capture_id}`, { as: BOB })).status).toBe(404);
  });
});

describe("PATCH and DELETE /v1/items/:id", () => {
  it("renames, sets willingness and confirms a needs_photos Item", async () => {
    const h = makeHarness();
    h.repo.addItem({
      id: "i1",
      ownerId: ALICE,
      status: "needs_photos",
      followUp: "Photo of the tag",
    });
    const res = await h.request("/v1/items/i1", {
      method: "PATCH",
      body: JSON.stringify({ title: "Jordan 1 Mid", willingness: "open_to_offers", confirm: true }),
      as: ALICE,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      title: "Jordan 1 Mid",
      willingness: "open_to_offers",
      status: "on_shelf",
      follow_up: null,
    });
  });

  it("does not touch someone else's Item", async () => {
    const h = makeHarness();
    h.repo.addItem({ id: "i1", ownerId: BOB });
    const res = await h.request("/v1/items/i1", {
      method: "PATCH",
      body: JSON.stringify({ title: "x" }),
      as: ALICE,
    });
    expect(res.status).toBe(404);
    expect((await h.request("/v1/items/i1", { method: "DELETE", as: ALICE })).status).toBe(404);
  });

  it("removes an Item, but not one reserved by a Deal", async () => {
    const h = makeHarness();
    h.repo.addItem({ id: "i1", ownerId: ALICE });
    h.repo.addItem({ id: "i2", ownerId: ALICE, status: "reserved", reservedByDealId: "d1" });
    expect((await h.request("/v1/items/i1", { method: "DELETE", as: ALICE })).status).toBe(200);
    expect(h.repo.items.find((i) => i.id === "i1")?.status).toBe("removed");
    expect((await h.request("/v1/items/i2", { method: "DELETE", as: ALICE })).status).toBe(409);
  });
});
