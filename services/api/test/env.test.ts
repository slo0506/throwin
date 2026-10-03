import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const base = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_JWT_SECRET: "secret",
};

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8787);
    expect(env.APP_ATTEST_MODE).toBe("off");
    expect(env.SUPABASE_JWKS_URL).toBeUndefined();
  });

  it("needs a JWT secret or a JWKS URL", () => {
    expect(() => loadEnv({ ...base, SUPABASE_JWT_SECRET: "" })).toThrow(/JWKS/);
    expect(
      loadEnv({
        ...base,
        SUPABASE_JWT_SECRET: "",
        SUPABASE_JWKS_URL: "https://abc.supabase.co/auth/v1/.well-known/jwks.json",
      }).SUPABASE_JWKS_URL,
    ).toContain("jwks.json");
  });

  it("rejects unknown App Attest modes", () => {
    expect(() => loadEnv({ ...base, APP_ATTEST_MODE: "maybe" })).toThrow(/APP_ATTEST_MODE/);
  });
});
