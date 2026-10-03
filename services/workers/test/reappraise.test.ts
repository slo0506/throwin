import { describe, expect, it } from "vitest";
import { changedMaterially, reappraiseItem } from "../src/appraiser/pipeline.js";
import { silentLogger } from "../src/log.js";
import {
  checkerJpeg,
  embedder,
  fakeVision,
  identification,
  MemoryStore,
  priceResult,
  solidJpeg,
  USER,
} from "./support.js";

const sneaker = identification({
  title: "Air Jordan 1 Mid",
  category: "sneakers",
  brand: "Nike",
  model: null,
  variant: null,
  condition_grade: "B",
  identity_confidence: 0.6,
  condition_confidence: 0.8,
  follow_up: "Photo of the size tag",
});

/** A needs_photos Item from an earlier capture, priced, with 1 new photo waiting. */
async function itemWithNewPhotos(photo?: Buffer) {
  const store = new MemoryStore();
  const cropPath = `${USER}/c1/crops/0.jpg`;
  store.files.set(cropPath, await solidJpeg("#888888", 400, 300));
  const itemId = await store.insertItem({
    userId: USER,
    captureId: "c1",
    status: "needs_photos",
    title: sneaker.title,
    identification: sneaker,
    cropPath,
    crop: { jpeg: Buffer.alloc(0), width: 400, height: 300 },
    cropBox: { frame: 0, box: [0.2, 0.2, 0.6, 0.6], source: "refined" },
  });
  await store.finishItem(itemId, {
    identification: sneaker,
    value: priceResult(120).value,
    model: "m",
    comps: { research: "", basis: [], cached: false },
  });
  const newPath = `${USER}/items/${itemId}/a.jpg`;
  store.files.set(newPath, photo ?? (await solidJpeg("#444444", 1200, 900)));
  store.addPhotos(itemId, [newPath]);
  return { store, itemId, newPath };
}

describe("reappraiseItem", () => {
  it("settles a follow-up without re-pricing when the identity holds", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    vision.reidentifyImpl = async (previous, photos) => {
      expect(previous.follow_up).toBe("Photo of the size tag");
      expect(photos).toHaveLength(1);
      return { ...previous, identity_confidence: 0.85, attributes: { size: "10" } };
    };
    const outcome = await reappraiseItem(itemId, USER, {
      store,
      vision,
      embedder,
      logger: silentLogger,
    });

    expect(outcome).toBe("updated");
    const item = store.item(itemId);
    expect(item.status).toBe("on_shelf");
    expect(item.identification.follow_up).toBeNull();
    expect(item.appraising).toBe(false);
    expect(vision.priceCalls).toBe(0);
    expect(item.priced?.value?.mid_usd).toBe(120);
    expect(store.reappraisals[0]?.update.priced).toBeUndefined();
    expect(store.reappraisals[0]?.update.inputMediaIds).toHaveLength(2);
    expect(item.appraisals).toBe(2);
  });

  it("re-prices when the photos show a different product, and asks again if still unsure", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    vision.reidentifyImpl = async (previous) => ({
      ...previous,
      title: "Air Jordan 1 Retro High OG Chicago",
      model: "555088-101",
      condition_confidence: 0.5,
      follow_up: "Photo of the soles",
    });
    vision.priceImpl = async () => priceResult(400);
    await reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger });

    const item = store.item(itemId);
    expect(vision.priceCalls).toBe(1);
    expect(item.priced?.value?.mid_usd).toBe(400);
    expect(item.status).toBe("needs_photos");
    expect(item.identification.follow_up).toBe("Photo of the soles");
    expect(store.embeddings).toHaveLength(1);
  });

  it("drops the old value when a different product can't be priced", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    vision.reidentifyImpl = async (previous) => ({ ...previous, condition_grade: "D" });
    vision.priceImpl = async () => {
      throw new Error("research failed");
    };
    await reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger });
    expect(store.item(itemId).priced?.value).toBeNull();
    expect(store.item(itemId).appraising).toBe(false);
  });

  it("makes a larger, sharper new photo the hero image", async () => {
    const { store, itemId } = await itemWithNewPhotos(await checkerJpeg());
    const vision = fakeVision({ objects: [] }, []);
    await reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger });
    const hero = store.item(itemId).media.find((m) => m.position === 0);
    expect(hero?.path).toMatch(new RegExp(`^${USER}/items/${itemId}/hero-[0-9a-f-]{36}\\.jpg$`));
    expect(store.files.has(hero?.path ?? "")).toBe(true);
    expect(new Set(store.item(itemId).media.map((m) => m.position)).size).toBe(3);
  });

  it("keeps the crop as hero when the new photo is not sharper", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    await reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger });
    expect(store.item(itemId).media.find((m) => m.position === 0)?.path).toContain("/crops/");
  });

  it("uses only the newest batch of photos", async () => {
    const { store, itemId, newPath } = await itemWithNewPhotos();
    for (const m of store.item(itemId).media) {
      if (m.path === newPath) m.createdAt = new Date(1000);
    }
    const later = `${USER}/items/${itemId}/b.jpg`;
    store.files.set(later, await solidJpeg("#222222", 800, 600));
    store.addPhotos(itemId, [later], new Date(2000));
    const vision = fakeVision({ objects: [] }, []);
    vision.reidentifyImpl = async (previous, photos) => {
      expect(photos.map((p) => p.width)).toEqual([800]);
      return previous;
    };
    await reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger });
    expect(vision.reidentifyCalls).toBe(1);
  });

  it("leaves the Item alone when the new photos show something private", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    vision.reidentifyImpl = async (previous) => ({
      ...previous,
      title: "Prescription pill bottle",
      is_tradeable_item: false,
    });
    expect(
      await reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger }),
    ).toBe("skipped");
    const item = store.item(itemId);
    expect(item.title).toBe("Air Jordan 1 Mid");
    expect(item.status).toBe("needs_photos");
    expect(item.appraising).toBe(false);
  });

  it("skips Items that are not appraising or not the user's", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    const deps = { store, vision, embedder, logger: silentLogger };
    expect(await reappraiseItem(itemId, "someone-else", deps)).toBe("skipped");
    store.item(itemId).appraising = false;
    expect(await reappraiseItem(itemId, USER, deps)).toBe("skipped");
    expect(vision.reidentifyCalls).toBe(0);
  });

  it("throws on a failed read so the job retries, leaving the Item appraising", async () => {
    const { store, itemId } = await itemWithNewPhotos();
    const vision = fakeVision({ objects: [] }, []);
    vision.reidentifyImpl = async () => {
      throw new Error("overloaded");
    };
    await expect(
      reappraiseItem(itemId, USER, { store, vision, embedder, logger: silentLogger }),
    ).rejects.toThrow("overloaded");
    expect(store.item(itemId).appraising).toBe(true);
    expect(store.item(itemId).title).toBe("Air Jordan 1 Mid");
  });
});

describe("changedMaterially", () => {
  it("ignores confidence and wording, catches product, variant and grade", () => {
    const lego = identification();
    expect(changedMaterially(lego, { ...lego, identity_confidence: 0.99 })).toBe(false);
    expect(changedMaterially(lego, { ...lego, title: "LEGO Ideas Typewriter" })).toBe(false);
    expect(changedMaterially(lego, { ...lego, model: "21328" })).toBe(true);
    expect(changedMaterially(lego, { ...lego, condition_grade: "C" })).toBe(true);
    expect(changedMaterially(sneaker, { ...sneaker, title: "Air Jordan 1 Mid sneaker" })).toBe(
      false,
    );
    expect(changedMaterially(sneaker, { ...sneaker, variant: "Bred" })).toBe(true);
    expect(changedMaterially(sneaker, { ...sneaker, title: "Nike Dunk Low" })).toBe(true);
  });
});
