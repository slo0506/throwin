import { randomBytes } from "node:crypto";
import {
  type Circle,
  CircleCreate,
  type CircleDetail,
  type CirclesResponse,
  type Invite,
  InviteCreate,
  type InvitePreview,
} from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import type { CircleMemberRecord, CircleRecord, InviteRecord, Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

const DAY_MS = 86_400_000;
const isUuid = (id: string) => z.uuid().safeParse(id).success;
// Matches the invites.code check constraint.
const isInviteCode = (code: string) => /^[A-Za-z0-9_-]{6,32}$/.test(code);

const circleNotFound = () =>
  new HttpError(404, "not_found", "That Circle doesn't exist or you're not in it");
const inviteNotFound = () =>
  new HttpError(404, "invite_not_found", "That invite link doesn't work anymore");

/** 10 URL-safe characters: about 60 bits, so codes can't be guessed. */
const newInviteCode = () => randomBytes(8).toString("base64url").slice(0, 10);

const toCircle = (c: CircleRecord): Circle => ({
  id: c.id,
  name: c.name,
  category_focus: c.categoryFocus,
  role: c.role,
  member_count: c.memberCount,
  created_at: c.createdAt.toISOString(),
});

const toDetail = (c: CircleRecord & { members: CircleMemberRecord[] }): CircleDetail => ({
  ...toCircle(c),
  members: c.members.map((m) => ({
    user_id: m.userId,
    first_name: m.displayName,
    photo_url: m.photoUrl,
    role: m.role,
    joined_at: m.joinedAt.toISOString(),
  })),
});

const toInvite = (i: InviteRecord): Invite => ({
  code: i.code,
  circle_id: i.circleId,
  max_uses: i.maxUses,
  uses: i.uses,
  expires_at: i.expiresAt.toISOString(),
});

/**
 * Circles the caller belongs to. Someone else's Circle is a 404, never a 403, so IDs cannot
 * be probed. Any member can invite.
 */
export const circleRoutes = (repo: Repository, now: () => Date) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const circles = await repo.listCircles(c.get("user").id);
      const body: CirclesResponse = { circles: circles.map(toCircle) };
      return c.json(body);
    })
    .post("/", async (c) => {
      const body = await parseJsonBody(c, CircleCreate);
      const circle = await repo.createCircle(c.get("user").id, {
        name: body.name,
        categoryFocus: [...new Set(body.category_focus)],
      });
      return c.json(toCircle(circle), 201);
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const circle = isUuid(id) ? await repo.getCircle(c.get("user").id, id.toLowerCase()) : null;
      if (!circle) throw circleNotFound();
      return c.json(toDetail(circle));
    })
    .post("/:id/invites", async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) throw circleNotFound();
      const body = await parseJsonBody(c, InviteCreate);
      const invite = await repo.createInvite(c.get("user").id, id.toLowerCase(), {
        code: newInviteCode(),
        maxUses: body.max_uses,
        expiresAt: new Date(now().getTime() + body.expires_in_days * DAY_MS),
      });
      if (!invite) throw circleNotFound();
      return c.json(toInvite(invite), 201);
    });

/** Invite landing and joining. Codes are case-sensitive, like the links that carry them. */
export const inviteRoutes = (repo: Repository, now: () => Date) =>
  new Hono<AppEnv>()
    .get("/:code", async (c) => {
      const code = c.req.param("code");
      const preview = isInviteCode(code)
        ? await repo.previewInvite(c.get("user").id, code, now())
        : null;
      if (!preview) throw inviteNotFound();
      const body: InvitePreview = {
        code: preview.code,
        circle_name: preview.circleName,
        inviter_first_name: preview.inviterName,
        member_count: preview.memberCount,
        status: preview.status,
      };
      return c.json(body);
    })
    .post("/:code/accept", async (c) => {
      const code = c.req.param("code");
      if (!isInviteCode(code)) throw inviteNotFound();
      const userId = c.get("user").id;
      const result = await repo.acceptInvite(userId, code, now());
      if (result === "not_found") throw inviteNotFound();
      if (result === "expired") {
        throw new HttpError(410, "invite_expired", "This invite expired. Ask for a new link.");
      }
      if (result === "full") {
        throw new HttpError(
          409,
          "invite_full",
          "This invite has been used up. Ask for a new link.",
        );
      }
      const circle = await repo.getCircle(userId, result.circleId);
      if (!circle) throw inviteNotFound();
      return c.json(toDetail(circle), result.joined ? 201 : 200);
    });
