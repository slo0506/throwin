import { AskCreate, AskPatch, type AsksResponse, type AskTarget } from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import { toOwnAsk } from "../lib/serialize.js";
import type { AskUpdate, Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

const notFound = () => new HttpError(404, "not_found", "That Ask isn't yours or doesn't exist");
const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** The Ask's title comes from the resolved target. */
const titleOf = (target: AskTarget) => target.name.slice(0, 120);

/**
 * Asks are owner-only: every read and write is scoped by the caller, and someone else's Ask
 * is a 404, never a 403, so IDs cannot be probed.
 */
export const askRoutes = (repo: Repository) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const asks = await repo.listAsks(c.get("user").id);
      const body: AsksResponse = { asks: asks.map(toOwnAsk) };
      return c.json(body);
    })
    .post("/", async (c) => {
      const body = await parseJsonBody(c, AskCreate);
      const ask = await repo.createAsk(c.get("user").id, {
        rawText: body.raw_text,
        target: body.target ?? null,
        title: body.target ? titleOf(body.target) : null,
        // A resolved target skips straight to asking what the user would offer.
        status: body.target ? "offering" : "drafting",
        cashCeilingCents: body.cash_ceiling_cents ?? 0,
        maxItems: body.max_items ?? 1,
        autonomy: body.autonomy ?? "every_deal",
      });
      return c.json(toOwnAsk(ask), 201);
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const ask = isUuid(id) ? await repo.getAsk(c.get("user").id, id.toLowerCase()) : null;
      if (!ask) throw notFound();
      return c.json(toOwnAsk(ask));
    })
    .patch("/:id", async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) throw notFound();
      const body = await parseJsonBody(c, AskPatch);
      const update: AskUpdate = {
        ...(body.raw_text !== undefined && { rawText: body.raw_text }),
        ...(body.target !== undefined && { target: body.target, title: titleOf(body.target) }),
        ...(body.offer_item_ids !== undefined && { offerItemIds: body.offer_item_ids }),
        ...(body.cash_ceiling_cents !== undefined && {
          cashCeilingCents: body.cash_ceiling_cents,
        }),
        ...(body.max_items !== undefined && { maxItems: body.max_items }),
        ...(body.autonomy !== undefined && { autonomy: body.autonomy }),
        ...(body.deadline !== undefined && {
          deadline: body.deadline === null ? null : new Date(body.deadline),
        }),
        ...(body.status === "cancelled" && { cancel: true as const }),
      };
      const result = await repo.updateAsk(c.get("user").id, id.toLowerCase(), update);
      if (result === "not_found") throw notFound();
      if (result === "invalid_offer_item") {
        throw new HttpError(
          400,
          "invalid_offer_item",
          "You can only offer your own Items that are on your Shelf and not in a pending deal",
        );
      }
      if (result === "ask_closed") {
        throw new HttpError(409, "ask_closed", "This Ask is closed and can't be changed");
      }
      return c.json(toOwnAsk(result));
    });
