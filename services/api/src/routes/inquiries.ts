import { type InquiriesResponse, InquiryAnswer } from "@throwin/shared";
import { Hono } from "hono";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import type { MediaStore } from "../repo/media.js";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

/**
 * The Liaison's questions to the user (docs/contracts/m3-matcher.md, "Inquiries"): would an
 * Item close to what they asked for work? Yes makes it a want and re-matches; no keeps it
 * away from that Ask.
 */
export const inquiryRoutes = (repo: Repository, media: MediaStore) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const inquiries = await repo.listInquiries(c.get("user").id);
      const paths = inquiries.flatMap((q) => (q.item.photoPath ? [q.item.photoPath] : []));
      const urls = paths.length
        ? await media.signedReadUrls([...new Set(paths)])
        : new Map<string, string | null>();
      const body: InquiriesResponse = {
        inquiries: inquiries.map((q) => ({
          id: q.id,
          ask_id: q.askId,
          ask_title: q.askTitle,
          item: {
            id: q.item.id,
            title: q.item.title,
            category: q.item.category,
            brand: q.item.brand,
            model: q.item.model,
            condition_grade: q.item.conditionGrade,
            value:
              q.item.valueLowCents !== null &&
              q.item.valueMidCents !== null &&
              q.item.valueHighCents !== null
                ? {
                    low_cents: q.item.valueLowCents,
                    mid_cents: q.item.valueMidCents,
                    high_cents: q.item.valueHighCents,
                    currency: "USD",
                  }
                : null,
            photo_url: q.item.photoPath ? (urls.get(q.item.photoPath) ?? null) : null,
          },
          expires_at: q.expiresAt.toISOString(),
        })),
      };
      return c.json(body);
    })
    .post("/:id/answer", async (c) => {
      const body = await parseJsonBody(c, InquiryAnswer);
      const result = await repo.answerInquiry(
        c.get("user").id,
        c.req.param("id").toLowerCase(),
        body.answer === "yes",
      );
      if (result === "not_found") {
        throw new HttpError(404, "not_found", "That question isn't yours or doesn't exist");
      }
      if (result === "closed") {
        throw new HttpError(409, "inquiry_closed", "That question was already answered or ran out");
      }
      return c.json({ result: "ok" as const });
    });
