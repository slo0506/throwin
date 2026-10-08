import { type DealItem, InterestAnswer, type InterestsResponse } from "@throwin/shared";
import { Hono } from "hono";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import type { MediaStore } from "../repo/media.js";
import type { DealItemRecord, Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

const toItem = (i: DealItemRecord, urls: Map<string, string | null>): DealItem => ({
  id: i.id,
  title: i.title,
  category: i.category,
  brand: i.brand,
  model: i.model,
  condition_grade: i.conditionGrade,
  value:
    i.valueLowCents !== null && i.valueMidCents !== null && i.valueHighCents !== null
      ? {
          low_cents: i.valueLowCents,
          mid_cents: i.valueMidCents,
          high_cents: i.valueHighCents,
          currency: "USD",
        }
      : null,
  photo_url: i.photoPath ? (urls.get(i.photoPath) ?? null) : null,
});

/**
 * "Someone wants your Item" (docs/contracts/m3-matcher.md, "Interests"): a Circle-mate's Ask
 * matches an Item the user offers for nothing. Yes names 1 thing the asker offers that the
 * user would take, which makes them an Ask for it and starts matching; no keeps the Item
 * away from that Ask.
 */
export const interestRoutes = (repo: Repository, media: MediaStore) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const interests = await repo.listInterests(c.get("user").id);
      const paths = interests.flatMap((n) =>
        [n.item, ...n.theirOffer].flatMap((i) => (i.photoPath ? [i.photoPath] : [])),
      );
      const urls = paths.length
        ? await media.signedReadUrls([...new Set(paths)])
        : new Map<string, string | null>();
      const body: InterestsResponse = {
        interests: interests.map((n) => ({
          id: n.id,
          wanter_first_name: n.wanterFirstName,
          ask_title: n.askTitle,
          item: toItem(n.item, urls),
          their_offer: n.theirOffer.map((i) => toItem(i, urls)),
          expires_at: n.expiresAt.toISOString(),
        })),
      };
      return c.json(body);
    })
    .post("/:id/answer", async (c) => {
      const body = await parseJsonBody(c, InterestAnswer);
      const result = await repo.answerInterest(
        c.get("user").id,
        c.req.param("id").toLowerCase(),
        body.answer === "yes" ? body.want_item_id.toLowerCase() : null,
      );
      if (result === "not_found") {
        throw new HttpError(404, "not_found", "That isn't yours or doesn't exist");
      }
      if (result === "closed") {
        throw new HttpError(409, "interest_closed", "They've moved on, or it ran out");
      }
      if (result === "invalid") {
        throw new HttpError(409, "interest_changed", "That Item isn't on offer any more");
      }
      return c.json({ result: "ok" as const });
    });
