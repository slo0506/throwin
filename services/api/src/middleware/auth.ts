import { createMiddleware } from "hono/factory";
import { InvalidTokenError, type TokenVerifier } from "../auth/verifier.js";
import { HttpError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const requireAuth = (tokens: TokenVerifier) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("Authorization");
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) throw new HttpError(401, "unauthorized", "Missing bearer token");
    try {
      const { userId, role } = await tokens.verify(match[1]);
      c.set("user", { id: userId, role });
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        throw new HttpError(401, "unauthorized", "Invalid or expired token");
      }
      throw err;
    }
    await next();
  });
