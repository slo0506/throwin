import { GmInputError, type GmService } from "@throwin/harness";
import {
  type GmConversation,
  type GmStreamEvent,
  PostGmMessage,
  type PostGmMessageResponse,
} from "@throwin/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { GmStreamHub } from "../gm/streams.js";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

export const KEEP_ALIVE_MS = 15_000;

export interface GmRouteDeps {
  /** Null when the GM is not configured (no Anthropic key): routes answer 503. */
  gm: GmService | null;
  streams: GmStreamHub;
  logger: Logger;
  keepAliveMs?: number;
}

function unavailable(): never {
  throw new HttpError(503, "gm_unavailable", "Your GM is offline right now. Try again soon.");
}

const asHttp = (err: unknown) =>
  err instanceof GmInputError ? new HttpError(err.status, err.code, err.message) : err;

export const gmRoutes = ({ gm, streams, logger, keepAliveMs = KEEP_ALIVE_MS }: GmRouteDeps) =>
  new Hono<AppEnv>()
    .get("/conversation", async (c) => {
      if (!gm) unavailable();
      try {
        const body: GmConversation = await gm.getConversation(c.get("user").id);
        return c.json(body);
      } catch (err) {
        throw asHttp(err);
      }
    })
    .post("/messages", async (c) => {
      if (!gm) unavailable();
      const userId = c.get("user").id;
      const body = await parseJsonBody(c, PostGmMessage);
      const stream = streams.tryStart(userId);
      if (!stream) {
        throw new HttpError(409, "turn_in_progress", "Your GM is still answering. One moment.");
      }
      let prepared: Awaited<ReturnType<GmService["prepareTurn"]>>;
      try {
        prepared = await gm.prepareTurn(userId, body);
      } catch (err) {
        streams.abandon(stream);
        throw asHttp(err);
      }
      // The turn runs in the background; the client reads it from the stream.
      void prepared
        .run((event) => streams.push(stream, event))
        .catch((err) => logger.error("gm_turn_unhandled", { user_id: userId, error: String(err) }))
        .finally(() => streams.finish(stream));
      const response: PostGmMessageResponse = {
        stream_id: stream.id,
        message_id: prepared.messageId,
      };
      return c.json(response, 202);
    })
    .get("/stream/:id", (c) => {
      const stream = streams.get(c.req.param("id"));
      if (!stream || stream.userId !== c.get("user").id) {
        throw new HttpError(404, "stream_not_found", "That stream has ended or doesn't exist");
      }
      return streamSSE(c, async (sse) => {
        let chain = Promise.resolve();
        let ended = false;
        await new Promise<void>((resolve) => {
          const finish = () => {
            if (ended) return;
            ended = true;
            clearInterval(timer);
            unsubscribe();
            resolve();
          };
          const write = (event: GmStreamEvent) => {
            chain = chain
              .then(() => sse.writeSSE({ event: event.event, data: JSON.stringify(event.data) }))
              .catch(() => finish());
            if (event.event === "done" || event.event === "error") void chain.then(finish);
          };
          const timer = setInterval(() => {
            chain = chain
              .then(async () => {
                await sse.write(": keep-alive\n\n");
              })
              .catch(() => finish());
          }, keepAliveMs);
          sse.onAbort(finish);
          const unsubscribe = stream.subscribe(write);
        });
        await chain;
      });
    });
