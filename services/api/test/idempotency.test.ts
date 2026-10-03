import { Me } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const patch = (body: unknown, key?: string) => ({
  as: ALICE,
  method: "PATCH",
  body: JSON.stringify(body),
  headers: key ? { "Idempotency-Key": key } : undefined,
});

describe("idempotency middleware", () => {
  it("replays the stored response for the same key and body", async () => {
    const { request, repo } = makeHarness();
    const first = await request("/v1/me", patch({ display_name: "First" }, "key-0000001"));
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // Change state behind the API's back: a replay must return the original response.
    const alice = repo.users.get(ALICE);
    if (alice) alice.displayName = "Changed";

    const second = await request("/v1/me", patch({ display_name: "First" }, "key-0000001"));
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await second.json()).toEqual(firstBody);
    expect(repo.users.get(ALICE)?.displayName).toBe("Changed");
  });

  it("returns 422 when a key is reused with a different body", async () => {
    const { request } = makeHarness();
    await request("/v1/me", patch({ display_name: "One" }, "key-0000002"));
    const res = await request("/v1/me", patch({ display_name: "Two" }, "key-0000002"));
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("idempotency_key_reused");
  });

  it("scopes keys by user", async () => {
    const { request } = makeHarness();
    await request("/v1/me", patch({ display_name: "Alice2" }, "key-0000003"));
    const res = await request("/v1/me", {
      as: BOB,
      method: "PATCH",
      body: JSON.stringify({ display_name: "Bob2" }),
      headers: { "Idempotency-Key": "key-0000003" },
    });
    expect(res.status).toBe(200);
    expect(Me.parse(await res.json()).display_name).toBe("Bob2");
  });

  it("replays DELETE /v1/me with the original body", async () => {
    const { request } = makeHarness();
    const init = { as: ALICE, method: "DELETE", headers: { "Idempotency-Key": "delete-me-01" } };
    const first = await request("/v1/me", init);
    const second = await request("/v1/me", init);
    expect(second.status).toBe(202);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });

  it("rejects malformed keys and ignores GETs", async () => {
    const { request } = makeHarness();
    const bad = await request("/v1/me", patch({ display_name: "X" }, "short"));
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("invalid_idempotency_key");
    const get = await request("/v1/me", { as: ALICE, headers: { "Idempotency-Key": "short" } });
    expect(get.status).toBe(200);
  });

  it("does not store server errors, so the client can retry", async () => {
    const { request, repo } = makeHarness();
    const original = repo.updateMe.bind(repo);
    repo.updateMe = async () => {
      throw new Error("db down");
    };
    const failed = await request("/v1/me", patch({ display_name: "Retry" }, "key-0000004"));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: { code: "internal", message: "Something went wrong" },
    });

    repo.updateMe = original;
    const retried = await request("/v1/me", patch({ display_name: "Retry" }, "key-0000004"));
    expect(retried.status).toBe(200);
    expect(retried.headers.get("Idempotent-Replayed")).toBeNull();
  });
});
