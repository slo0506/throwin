import { Circle, CircleDetail, CirclesResponse, Invite, InvitePreview } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, errorCode, makeHarness, NOW } from "./helpers.js";

const CAROL = "33333333-3333-4333-8333-333333333333";
const DAY_MS = 86_400_000;

function setup() {
  const h = makeHarness();
  h.repo.addUser(CAROL, { displayName: "Carol" });
  const call = (method: string, path: string, body?: unknown, as = ALICE) =>
    h.request(path, {
      method,
      as,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const createCircle = async (body: unknown = { name: "Thursday Lego" }, as = ALICE) => {
    const res = await call("POST", "/v1/circles", body, as);
    expect(res.status).toBe(201);
    return Circle.parse(await res.json());
  };
  const invite = async (circleId: string, body: unknown = {}, as = ALICE) => {
    const res = await call("POST", `/v1/circles/${circleId}/invites`, body, as);
    expect(res.status).toBe(201);
    return Invite.parse(await res.json());
  };
  return { ...h, call, createCircle, invite };
}

describe("Circles", () => {
  it("creates a Circle with the creator as owner and only member", async () => {
    const { createCircle, call } = setup();
    const circle = await createCircle({ name: "  Thursday Lego ", category_focus: ["Toys/LEGO"] });
    expect(circle).toMatchObject({
      name: "Thursday Lego",
      category_focus: ["toys/lego"],
      role: "owner",
      member_count: 1,
    });
    const list = CirclesResponse.parse(await (await call("GET", "/v1/circles")).json());
    expect(list.circles.map((c) => c.id)).toEqual([circle.id]);
    const detail = CircleDetail.parse(await (await call("GET", `/v1/circles/${circle.id}`)).json());
    expect(detail.members).toEqual([
      expect.objectContaining({ user_id: ALICE, first_name: "Alice", role: "owner" }),
    ]);
  });

  it("rejects bad names and categories", async () => {
    const { call } = setup();
    for (const body of [
      { name: "" },
      { name: "x".repeat(61) },
      { name: "ok", category_focus: ["not a path!"] },
      { name: "ok", owner_id: BOB },
    ]) {
      const res = await call("POST", "/v1/circles", body);
      expect(res.status).toBe(400);
    }
  });

  it("hides Circles from people who aren't in them", async () => {
    const { createCircle, call } = setup();
    const circle = await createCircle();
    for (const path of [`/v1/circles/${circle.id}`, "/v1/circles/not-a-uuid"]) {
      const res = await call("GET", path, undefined, BOB);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    const invite = await call("POST", `/v1/circles/${circle.id}/invites`, {}, BOB);
    expect(invite.status).toBe(404);
    const list = CirclesResponse.parse(
      await (await call("GET", "/v1/circles", undefined, BOB)).json(),
    );
    expect(list.circles).toEqual([]);
  });
});

describe("Invites", () => {
  it("makes a 14-day, 25-use code by default", async () => {
    const { createCircle, invite } = setup();
    const circle = await createCircle();
    const code = await invite(circle.id);
    expect(code).toMatchObject({ circle_id: circle.id, max_uses: 25, uses: 0 });
    expect(code.code).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(new Date(code.expires_at).getTime()).toBe(NOW.getTime() + 14 * DAY_MS);
  });

  it("previews, then joins, and a repeat join is free", async () => {
    const { createCircle, invite, call, repo } = setup();
    const circle = await createCircle();
    const { code } = await invite(circle.id);

    const preview = InvitePreview.parse(
      await (await call("GET", `/v1/invites/${code}`, undefined, BOB)).json(),
    );
    expect(preview).toEqual({
      code,
      circle_name: "Thursday Lego",
      inviter_first_name: "Alice",
      member_count: 1,
      status: "open",
    });

    const joined = await call("POST", `/v1/invites/${code}/accept`, undefined, BOB);
    expect(joined.status).toBe(201);
    const detail = CircleDetail.parse(await joined.json());
    expect(detail).toMatchObject({ id: circle.id, role: "member", member_count: 2 });
    expect(detail.members.map((m) => m.first_name)).toEqual(["Alice", "Bob"]);

    const again = await call("POST", `/v1/invites/${code}/accept`, undefined, BOB);
    expect(again.status).toBe(200);
    expect(repo.invites.find((i) => i.code === code)?.uses).toBe(1);
    const status = InvitePreview.parse(
      await (await call("GET", `/v1/invites/${code}`, undefined, BOB)).json(),
    ).status;
    expect(status).toBe("already_member");

    // The new member can now see the Circle and invite others.
    expect((await call("GET", `/v1/circles/${circle.id}`, undefined, BOB)).status).toBe(200);
    expect((await call("POST", `/v1/circles/${circle.id}/invites`, {}, BOB)).status).toBe(201);
  });

  it("refuses full, expired, unknown and paused-Circle codes", async () => {
    const { createCircle, invite, call, repo } = setup();
    const circle = await createCircle();
    const one = await invite(circle.id, { max_uses: 1 });
    expect((await call("POST", `/v1/invites/${one.code}/accept`, undefined, BOB)).status).toBe(201);

    const full = await call("POST", `/v1/invites/${one.code}/accept`, undefined, CAROL);
    expect(full.status).toBe(409);
    expect(await errorCode(full)).toBe("invite_full");
    const fullPreview = await call("GET", `/v1/invites/${one.code}`, undefined, CAROL);
    expect(InvitePreview.parse(await fullPreview.json()).status).toBe("full");

    const old = await invite(circle.id, { expires_in_days: 1 });
    const stored = repo.invites.find((i) => i.code === old.code);
    if (stored) stored.expiresAt = new Date(NOW.getTime() - 1);
    const expired = await call("POST", `/v1/invites/${old.code}/accept`, undefined, CAROL);
    expect(expired.status).toBe(410);
    expect(await errorCode(expired)).toBe("invite_expired");

    for (const code of ["NOPE-NOPE", "bad code!", "x"]) {
      const res = await call(
        "POST",
        `/v1/invites/${encodeURIComponent(code)}/accept`,
        undefined,
        CAROL,
      );
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("invite_not_found");
    }

    const open = await invite(circle.id);
    const paused = repo.circles.find((c) => c.id === circle.id);
    if (paused) paused.status = "paused";
    expect((await call("GET", `/v1/invites/${open.code}`, undefined, CAROL)).status).toBe(404);
    expect((await call("POST", `/v1/invites/${open.code}/accept`, undefined, CAROL)).status).toBe(
      404,
    );
    expect(repo.memberships.some((m) => m.userId === CAROL)).toBe(false);
  });

  it("caps invite size and lifetime", async () => {
    const { createCircle, call } = setup();
    const circle = await createCircle();
    for (const body of [{ max_uses: 0 }, { max_uses: 201 }, { expires_in_days: 31 }]) {
      const res = await call("POST", `/v1/circles/${circle.id}/invites`, body);
      expect(res.status).toBe(400);
    }
  });
});
