import {
  AnswerRequest,
  type AnswerResponse,
  compareQuestions,
  QuestionsQuery,
  type QuestionsResponse,
} from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import { toQuestion, toShelfItem } from "../lib/serialize.js";
import type { MediaStore } from "../repo/media.js";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";
import { thumbnailUrls } from "./items.js";

/** Tune up shows at most this many questions at once. */
export const MAX_QUESTIONS = 20;

const isUuid = (id: string) => z.uuid().safeParse(id).success;
const notFound = () => new HttpError(404, "not_found", "That question isn't on your Shelf");

export const questionRoutes = (repo: Repository, media: MediaStore) =>
  new Hono<AppEnv>()
    // Open questions across the caller's Shelf (or 1 Item), best first by impact over effort.
    .get("/", async (c) => {
      const query = QuestionsQuery.safeParse(c.req.query());
      if (!query.success) {
        const message = query.error.issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ");
        throw new HttpError(400, "validation_error", message);
      }
      const records = (await repo.listOpenQuestions(c.get("user").id, query.data.item_id))
        .sort(compareQuestions)
        .slice(0, MAX_QUESTIONS);
      const paths = records.map((q) => q.thumbnailPath).filter((p): p is string => p !== null);
      const urls = await media.signedReadUrls(paths);
      const body: QuestionsResponse = { questions: records.map((q) => toQuestion(q, urls)) };
      return c.json(body);
    })
    // Answer or skip. The Refiner folds it into the Item in the background.
    .post("/:id/answer", async (c) => {
      const userId = c.get("user").id;
      const body = await parseJsonBody(c, AnswerRequest);
      const questionId = c.req.param("id");
      if (!isUuid(questionId)) throw notFound();
      const outcome = await repo.answerQuestion(
        userId,
        questionId,
        "skip" in body ? { skip: true } : { answer: body.answer },
      );
      switch (outcome.result) {
        case "not_found":
          throw notFound();
        case "already_answered":
          throw new HttpError(409, "already_answered", "That question was already answered");
        case "item_reserved":
          throw new HttpError(409, "item_reserved", "This item is part of a pending deal");
        case "use_media_upload":
          throw new HttpError(
            409,
            "use_media_upload",
            "Answer photo questions by adding photos to the item",
          );
        case "invalid_answer":
          throw new HttpError(
            400,
            "validation_error",
            "answer: must be 1 of the question's options",
          );
      }
      const item = await repo.getItem(userId, outcome.itemId);
      if (!item) throw notFound();
      const response: AnswerResponse = {
        item: toShelfItem(item, await thumbnailUrls(media, [item])),
      };
      return c.json(response, 202);
    });
