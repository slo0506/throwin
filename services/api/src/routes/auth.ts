import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { SessionError, type SessionIssuer, type SessionTokens } from "../auth/sessions.js";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

const DevSessionBody = z.strictObject({
  email: z.email().max(254),
  first_name: z.string().trim().min(1).max(50),
  code: z.string().min(1).max(128),
});

const RefreshBody = z.strictObject({ refresh_token: z.string().min(1).max(4096) });

const toWire = (t: SessionTokens) => ({
  access_token: t.accessToken,
  refresh_token: t.refreshToken,
  expires_at: t.expiresAt,
  user_id: t.userId,
});

function codesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Session endpoints. `/auth/dev-session` exists only while DEV_AUTH_CODE is set and is
 * replaced by Sign in with Apple before launch.
 */
export const authRoutes = (sessions: SessionIssuer, devAuthCode: string | undefined) =>
  new Hono<AppEnv>()
    .post("/dev-session", async (c) => {
      if (!devAuthCode) throw new HttpError(404, "not_found", "Not found");
      const body = await parseJsonBody(c, DevSessionBody);
      if (!codesMatch(body.code, devAuthCode)) {
        throw new HttpError(403, "invalid_code", "That access code isn't right");
      }
      try {
        const tokens = await sessions.devSignIn(body.email.toLowerCase(), body.first_name);
        return c.json(toWire(tokens), 201);
      } catch (err) {
        if (err instanceof SessionError) throw new HttpError(502, "auth_failed", err.message);
        throw err;
      }
    })
    .post("/refresh", async (c) => {
      const body = await parseJsonBody(c, RefreshBody);
      try {
        return c.json(toWire(await sessions.refresh(body.refresh_token)));
      } catch (err) {
        if (err instanceof SessionError) {
          throw new HttpError(401, "refresh_failed", "Session expired. Sign in again.");
        }
        throw err;
      }
    });
