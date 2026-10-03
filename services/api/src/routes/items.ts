import { ItemPatch, type ShelfResponse } from "@throwin/shared";
import { Hono } from "hono";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import { toShelfItem } from "../lib/serialize.js";
import type { MediaStore } from "../repo/media.js";
import type { ItemRecord, Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

/** Signs every thumbnail in 1 round trip. */
export async function thumbnailUrls(media: MediaStore, items: ItemRecord[]) {
  const paths = items.map((i) => i.thumbnailPath).filter((p): p is string => p !== null);
  return media.signedReadUrls(paths);
}

export const itemRoutes = (repo: Repository, media: MediaStore) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const userId = c.get("user").id;
      const me = await repo.getMe(userId);
      if (!me || me.deletedAt) {
        throw new HttpError(410, "account_deleted", "This account is not active");
      }
      const items = await repo.listShelfItems(userId);
      const urls = await thumbnailUrls(media, items);
      const body: ShelfResponse = { items: items.map((i) => toShelfItem(i, urls)) };
      return c.json(body);
    })
    .patch("/:id", async (c) => {
      const body = await parseJsonBody(c, ItemPatch);
      const item = await repo.updateItem(c.get("user").id, c.req.param("id"), {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.willingness !== undefined && { willingness: body.willingness }),
        ...(body.condition_grade !== undefined && { conditionGrade: body.condition_grade }),
        ...(body.confirm && { confirm: true }),
      });
      if (!item) throw new HttpError(404, "item_not_found", "That item isn't on your Shelf");
      return c.json(toShelfItem(item, await thumbnailUrls(media, [item])));
    })
    .delete("/:id", async (c) => {
      const result = await repo.removeItem(c.get("user").id, c.req.param("id"));
      if (result === "not_found") {
        throw new HttpError(404, "item_not_found", "That item isn't on your Shelf");
      }
      if (result === "reserved") {
        throw new HttpError(409, "item_reserved", "This item is part of a pending deal");
      }
      return c.json({ status: "removed" });
    });
