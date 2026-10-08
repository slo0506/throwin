import type { NextUpResponse } from "@throwin/shared";
import { Hono } from "hono";
import { buildNextUp } from "../lib/next-up.js";
import type { MediaStore } from "../repo/media.js";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

/** GET /v1/next-up: what needs the user, best first (see lib/next-up.ts). */
export const nextUpRoutes = (repo: Repository, media: MediaStore, now: () => Date) =>
  new Hono<AppEnv>().get("/", async (c) => {
    const userId = c.get("user").id;
    const [deals, photoRequests, asks, items, circles, demand, inquiries, interests] =
      await Promise.all([
        repo.listDeals(userId),
        repo.listPhotoRequests(userId),
        repo.listAsks(userId),
        repo.listShelfItems(userId),
        repo.listCircles(userId),
        repo.getDemand(userId),
        repo.listInquiries(userId),
        repo.listInterests(userId),
      ]);
    const paths = [
      ...deals.flatMap((d) => d.legs.flatMap((l) => (l.item.photoPath ? [l.item.photoPath] : []))),
      ...photoRequests.flatMap((r) => (r.thumbnailPath ? [r.thumbnailPath] : [])),
      ...items.flatMap((i) => (i.thumbnailPath ? [i.thumbnailPath] : [])),
      ...inquiries.flatMap((q) => (q.item.photoPath ? [q.item.photoPath] : [])),
      ...interests.flatMap((n) => (n.item.photoPath ? [n.item.photoPath] : [])),
    ];
    const urls = paths.length
      ? await media.signedReadUrls([...new Set(paths)])
      : new Map<string, string | null>();
    const body: NextUpResponse = {
      items: buildNextUp({
        userId,
        now: now(),
        deals,
        photoRequests,
        asks,
        items,
        circles,
        demand,
        inquiries,
        interests,
        urls,
      }),
    };
    return c.json(body);
  });
