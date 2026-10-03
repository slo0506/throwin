import { createMiddleware } from "hono/factory";
import { HttpError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import type { Logger } from "../lib/logger.js";
import type { IdempotencyRef, IdempotencyStore } from "../repo/idempotency.js";
import type { AppEnv } from "../types.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const KEY_PATTERN = /^[\x21-\x7E]{8,255}$/;

/**
 * Mobile networks retry, so every mutating request may carry an Idempotency-Key.
 * The stored record is scoped by user, method and path, and remembers a hash of the body:
 * the same key with a different body is a client bug and gets a 422.
 */
export const idempotency = (store: IdempotencyStore, logger: Logger, now: () => Date) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!MUTATING.has(c.req.method)) return next();
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(key)) {
      throw new HttpError(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must be 8 to 255 printable ASCII characters",
      );
    }

    const ref: IdempotencyRef = {
      userId: c.get("user").id,
      key,
      method: c.req.method,
      path: c.req.path,
    };
    // Hono caches the body, so route handlers can still read it after this.
    const body = await c.req.text();
    const requestHash = sha256Hex(`${ref.method}\n${ref.path}\n${body}`);

    const begun = await store.begin(ref, requestHash, now());
    switch (begun.kind) {
      case "mismatch":
        throw new HttpError(
          422,
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request",
        );
      case "in_progress":
        throw new HttpError(
          409,
          "idempotency_in_progress",
          "A request with this key is in progress",
        );
      case "replay": {
        const headers = new Headers({ [REPLAYED_HEADER]: "true" });
        if (begun.response.contentType) headers.set("Content-Type", begun.response.contentType);
        // 204 and 304 must not carry a body, or the Response constructor throws.
        const { status, body } = begun.response;
        const empty = status === 204 || status === 304;
        return new Response(empty ? null : body, { status, headers });
      }
      case "started":
        break;
    }

    await next();

    try {
      if (c.res.status >= 500) {
        await store.release(ref);
        return;
      }
      await store.complete(ref, {
        status: c.res.status,
        body: await c.res.clone().text(),
        contentType: c.res.headers.get("Content-Type"),
      });
    } catch (err) {
      // The request already succeeded; a failed save only costs us replay protection.
      logger.error("idempotency_save_failed", {
        request_id: c.get("requestId"),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
