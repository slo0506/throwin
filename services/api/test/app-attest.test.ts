import { describe, expect, it } from "vitest";
import type { AppAttestVerifier } from "../src/middleware/app-attest.js";
import { ALICE, errorCode, makeHarness } from "./helpers.js";

const accepting: AppAttestVerifier = { verifyAssertion: async (i) => i.assertion === "good" };

describe("App Attest middleware", () => {
  it("off: ignores the header entirely", async () => {
    const { request } = makeHarness({ appAttestMode: "off" });
    expect((await request("/v1/me", { as: ALICE })).status).toBe(200);
  });

  it("log: lets requests through without an assertion", async () => {
    const { request } = makeHarness({ appAttestMode: "log" });
    expect((await request("/v1/me", { as: ALICE })).status).toBe(200);
  });

  it("enforce: requires a valid assertion", async () => {
    const { request } = makeHarness({ appAttestMode: "enforce", appAttestVerifier: accepting });
    const missing = await request("/v1/me", { as: ALICE });
    expect(missing.status).toBe(401);
    expect(await errorCode(missing)).toBe("app_attest_required");

    const invalid = await request("/v1/me", {
      as: ALICE,
      headers: { "X-Apple-AppAttest-Assertion": "bad" },
    });
    expect(invalid.status).toBe(401);
    expect(await errorCode(invalid)).toBe("app_attest_invalid");

    const ok = await request("/v1/me", {
      as: ALICE,
      headers: { "X-Apple-AppAttest-Assertion": "good" },
    });
    expect(ok.status).toBe(200);
  });

  it("does not apply to /healthz", async () => {
    const { request } = makeHarness({ appAttestMode: "enforce" });
    expect((await request("/healthz")).status).toBe(200);
  });
});
