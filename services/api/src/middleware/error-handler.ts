import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorBody, HttpError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

export const createErrorHandler =
  (logger: Logger): ErrorHandler<AppEnv> =>
  (err, c) => {
    if (err instanceof HttpError) {
      return c.json(errorBody(err.code, err.message), err.status);
    }
    if (err instanceof HTTPException) {
      return c.json(errorBody("http_error", err.message || "Request failed"), err.status);
    }
    logger.error("unhandled_error", {
      request_id: c.get("requestId"),
      error:
        err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    });
    return c.json(errorBody("internal", "Something went wrong"), 500);
  };

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(errorBody("not_found", "No route for this request"), 404);
