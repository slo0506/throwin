import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createSupabaseVerifier } from "../src/auth/verifier.js";
import { ALICE, errorCode, JWT_SECRET, makeHarness, signToken } from "./helpers.js";

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("auth middleware", () => {
  it("rejects a missing token", async () => {
    const { request } = makeHarness();
    const res = await request("/v1/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Missing bearer token" },
    });
  });

  it("rejects garbage, wrong secrets, wrong audience, anon role and expired tokens", async () => {
    const { request } = makeHarness();
    const bad = [
      "not-a-jwt",
      await signToken(ALICE, { secret: "some-other-secret-that-is-long-enough" }),
      await signToken(ALICE, { aud: "anon" }),
      await signToken(ALICE, { role: "anon" }),
      await signToken(ALICE, { expiresIn: "-1m" }),
      await signToken("not-a-uuid"),
    ];
    for (const token of bad) {
      const res = await request("/v1/me", bearer(token));
      expect(res.status, token).toBe(401);
      expect(await errorCode(res)).toBe("unauthorized");
    }
  });

  it("accepts asymmetric tokens through a JWKS", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
    const tokens = createSupabaseVerifier({
      jwtSecret: JWT_SECRET,
      jwks: createLocalJWKSet({ keys: [jwk] }),
    });
    const { request } = makeHarness({ tokens });
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(ALICE)
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await request("/v1/me", bearer(token));
    expect(res.status).toBe(200);
  });

  it("rejects asymmetric tokens when no JWKS is configured", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const { request } = makeHarness();
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(ALICE)
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(privateKey);
    expect((await request("/v1/me", bearer(token))).status).toBe(401);
  });
});
