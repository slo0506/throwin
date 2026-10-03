import type { TasteFactsResponse } from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { toTasteFact } from "../lib/serialize.js";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** The taste facts screen in Settings: see every active fact, delete any of them. */
export const tasteFactRoutes = (repo: Repository) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const facts = await repo.listTasteFacts(c.get("user").id);
      const body: TasteFactsResponse = { facts: facts.map(toTasteFact) };
      return c.json(body);
    })
    // Marks the fact deleted. The GM never uses it again and the extractor never rewrites it.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const deleted = isUuid(id)
        ? await repo.deleteTasteFact(c.get("user").id, id.toLowerCase())
        : false;
      if (!deleted) throw new HttpError(404, "not_found", "That fact doesn't exist");
      return c.body(null, 204);
    });
