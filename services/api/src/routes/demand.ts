import type { DemandResponse } from "@throwin/shared";
import { Hono } from "hono";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

/** GET /v1/demand: what people in the user's Circles want, as counts only. */
export const demandRoutes = (repo: Repository) =>
  new Hono<AppEnv>().get("/", async (c) => {
    const demand = await repo.getDemand(c.get("user").id);
    const body: DemandResponse = {
      demand: demand.map((d) => ({
        label: d.label,
        category: d.category,
        askers: d.askers,
        your_item_ids: d.itemIds,
      })),
    };
    return c.json(body);
  });
