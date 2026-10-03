import type { ShelfResponse } from "@throwin/shared";
import { Hono } from "hono";
import { HttpError } from "../lib/errors.js";
import { toShelfItem } from "../lib/serialize.js";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

export const itemRoutes = (repo: Repository) =>
  new Hono<AppEnv>().get("/", async (c) => {
    const userId = c.get("user").id;
    const me = await repo.getMe(userId);
    if (!me || me.deletedAt) {
      throw new HttpError(410, "account_deleted", "This account is not active");
    }
    const items = await repo.listShelfItems(userId);
    const body: ShelfResponse = { items: items.map(toShelfItem) };
    return c.json(body);
  });
