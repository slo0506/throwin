import { randomUUID } from "node:crypto";
import {
  ItemMediaRequest,
  ItemMediaUploadRequest,
  type ItemMediaUploadResponse,
  ItemPatch,
  type ShelfResponse,
} from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
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

/** Storage layout for follow-up photos: {user}/items/{item}/{uuid}.jpg. */
export const itemMediaPrefix = (userId: string, itemId: string) => `${userId}/items/${itemId}/`;

const notFound = () => new HttpError(404, "not_found", "That item isn't on your Shelf");
const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** The caller's Item, or a 404. Malformed IDs are a 404 too, never a database error. */
async function ownItem(repo: Repository, userId: string, itemId: string) {
  const item = isUuid(itemId) ? await repo.getItem(userId, itemId) : null;
  if (!item) throw notFound();
  return item;
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
    .get("/:id", async (c) => {
      const item = await ownItem(repo, c.get("user").id, c.req.param("id"));
      return c.json(toShelfItem(item, await thumbnailUrls(media, [item])));
    })
    // Follow-up photos, step 1: 1 signed upload URL per photo, in the Item's own folder.
    .post("/:id/media/uploads", async (c) => {
      const userId = c.get("user").id;
      const body = await parseJsonBody(c, ItemMediaUploadRequest);
      const item = await ownItem(repo, userId, c.req.param("id"));
      const uploads = await Promise.all(
        Array.from({ length: body.count }, async () => {
          const path = `${itemMediaPrefix(userId, item.id)}${randomUUID()}.jpg`;
          return { path, upload_url: await media.createUploadUrl(path) };
        }),
      );
      const response: ItemMediaUploadResponse = { uploads };
      return c.json(response, 201);
    })
    // Follow-up photos, step 2: record them and send the Item back to the Appraiser.
    .post("/:id/media", async (c) => {
      const userId = c.get("user").id;
      const body = await parseJsonBody(c, ItemMediaRequest);
      const itemId = c.req.param("id");
      if (!isUuid(itemId)) throw notFound();
      const prefix = itemMediaPrefix(userId, itemId);
      if (body.media.some((m) => !m.path.startsWith(prefix) || m.path.includes(".."))) {
        throw new HttpError(400, "invalid_media_path", "Photos must come from this item's uploads");
      }
      const result = await repo.submitItemMedia(userId, itemId, body.media);
      if (result === "not_found") throw notFound();
      if (result === "conflict") {
        throw new HttpError(
          409,
          "conflict",
          "This item is part of a pending deal or is already being appraised",
        );
      }
      return c.json(toShelfItem(result, await thumbnailUrls(media, [result])), 202);
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
