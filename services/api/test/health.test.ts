import { describe, expect, it } from "vitest";
import { makeHarness } from "./helpers.js";

describe("GET /healthz", () => {
  it("is public and returns ok with a request id", async () => {
    const { request } = makeHarness();
    const res = await request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("echoes a client request id", async () => {
    const { request } = makeHarness();
    const res = await request("/healthz", { headers: { "X-Request-Id": "abc-123" } });
    expect(res.headers.get("X-Request-Id")).toBe("abc-123");
  });

  it("returns the JSON error shape for unknown routes", async () => {
    const { request } = makeHarness();
    const res = await request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "No route for this request" },
    });
  });
});
