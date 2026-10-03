import { describe, expect, it } from "vitest";
import { errorCode, makeHarness } from "./helpers.js";

const body = (o: Record<string, unknown>) => ({ method: "POST", body: JSON.stringify(o) });

describe("POST /auth/dev-session", () => {
  it("is hidden when no dev code is configured", async () => {
    const h = makeHarness();
    const res = await h.request(
      "/auth/dev-session",
      body({ email: "a@b.co", first_name: "Sean", code: "x" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a wrong code", async () => {
    const h = makeHarness({ devAuthCode: "letmein" });
    const res = await h.request(
      "/auth/dev-session",
      body({ email: "a@b.co", first_name: "Sean", code: "nope" }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("invalid_code");
  });

  it("issues a session and lowercases the email", async () => {
    const h = makeHarness({ devAuthCode: "letmein" });
    const res = await h.request(
      "/auth/dev-session",
      body({ email: "Sean@Example.com", first_name: "Sean", code: "letmein" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2000000000,
      user_id: "u1",
    });
    expect(h.sessions.signIns).toEqual([{ email: "sean@example.com", firstName: "Sean" }]);
  });

  it("validates the body", async () => {
    const h = makeHarness({ devAuthCode: "letmein" });
    const res = await h.request(
      "/auth/dev-session",
      body({ email: "not-an-email", first_name: "", code: "letmein" }),
    );
    expect(res.status).toBe(400);
  });

  it("maps provider failures to 502", async () => {
    const h = makeHarness({ devAuthCode: "letmein" });
    h.sessions.fail = true;
    const res = await h.request(
      "/auth/dev-session",
      body({ email: "a@b.co", first_name: "Sean", code: "letmein" }),
    );
    expect(res.status).toBe(502);
  });
});

describe("POST /auth/refresh", () => {
  it("refreshes a session", async () => {
    const h = makeHarness();
    const res = await h.request("/auth/refresh", body({ refresh_token: "refresh" }));
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBe("access2");
  });

  it("returns 401 for a bad refresh token", async () => {
    const h = makeHarness();
    const res = await h.request("/auth/refresh", body({ refresh_token: "stale" }));
    expect(res.status).toBe(401);
  });
});
