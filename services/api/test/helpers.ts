import type { GmService } from "@throwin/harness";
import { ErrorBody } from "@throwin/shared";
import { SignJWT } from "jose";
import { createApp } from "../src/app.js";
import { createSupabaseVerifier, type TokenVerifier } from "../src/auth/verifier.js";
import { silentLogger } from "../src/lib/logger.js";
import {
  type AppAttestMode,
  type AppAttestVerifier,
  UnimplementedAppAttestVerifier,
} from "../src/middleware/app-attest.js";
import { MemoryIdempotencyStore } from "../src/repo/idempotency.js";
import { MemoryMediaStore } from "../src/repo/media.js";
import { MemoryRepository } from "../src/repo/memory.js";
import { FakeSessionIssuer } from "./fakes.js";

export const JWT_SECRET = "test-secret-at-least-32-characters-long!!";
export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const NOW = new Date("2026-10-03T12:00:00.000Z");

export async function signToken(
  sub: string,
  overrides: { role?: string; aud?: string; secret?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({ role: overrides.role ?? "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setAudience(overrides.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "1h")
    .sign(new TextEncoder().encode(overrides.secret ?? JWT_SECRET));
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  repo: MemoryRepository;
  idempotency: MemoryIdempotencyStore;
  sessions: FakeSessionIssuer;
  media: MemoryMediaStore;
  request: (path: string, init?: RequestInit & { as?: string }) => Promise<Response>;
}

export function makeHarness(
  options: {
    tokens?: TokenVerifier;
    appAttestMode?: AppAttestMode;
    appAttestVerifier?: AppAttestVerifier;
    devAuthCode?: string;
    gm?: GmService;
    gmKeepAliveMs?: number;
  } = {},
): Harness {
  const repo = new MemoryRepository();
  const idempotency = new MemoryIdempotencyStore();
  repo.addUser(ALICE, { displayName: "Alice" });
  repo.addUser(BOB, { displayName: "Bob" });

  const sessions = new FakeSessionIssuer();
  const media = new MemoryMediaStore();
  const app = createApp({
    sessions,
    devAuthCode: options.devAuthCode,
    media,
    repo,
    idempotency,
    tokens: options.tokens ?? createSupabaseVerifier({ jwtSecret: JWT_SECRET }),
    appAttest: {
      mode: options.appAttestMode ?? "off",
      verifier: options.appAttestVerifier ?? new UnimplementedAppAttestVerifier(),
    },
    logger: silentLogger,
    now: () => NOW,
    ...(options.gm && { gm: options.gm }),
    ...(options.gmKeepAliveMs !== undefined && { gmKeepAliveMs: options.gmKeepAliveMs }),
  });

  const request = async (path: string, init: RequestInit & { as?: string } = {}) => {
    const { as, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (as) headers.set("Authorization", `Bearer ${await signToken(as)}`);
    if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return app.request(path, { ...rest, headers });
  };

  return { app, repo, idempotency, sessions, media, request };
}

/** Reads an error response's code, failing loudly if the body is not the error shape. */
export async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}
