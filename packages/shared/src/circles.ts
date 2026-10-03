import { z } from "zod";
import { CircleRole } from "./enums.js";

// Circles and invites (Milestone 3). Shapes are fixed by docs/contracts/m3-circles.md.

export const Circle = z.object({
  id: z.uuid(),
  name: z.string(),
  category_focus: z.array(z.string()),
  /** The caller's role in this Circle. */
  role: CircleRole,
  member_count: z.number().int().positive(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Circle = z.infer<typeof Circle>;

export const CirclesResponse = z.object({ circles: z.array(Circle) });
export type CirclesResponse = z.infer<typeof CirclesResponse>;

/** Only what other members may see: first name and photo, never contact details. */
export const CircleMember = z.object({
  user_id: z.uuid(),
  first_name: z.string().nullable(),
  photo_url: z.string().nullable(),
  role: CircleRole,
  joined_at: z.iso.datetime({ offset: true }),
});
export type CircleMember = z.infer<typeof CircleMember>;

export const CircleDetail = Circle.extend({ members: z.array(CircleMember) });
export type CircleDetail = z.infer<typeof CircleDetail>;

/** Category paths like "toys/lego", the same form Items use. */
const categoryPath = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/)
  .max(60);

export const CircleCreate = z.strictObject({
  name: z.string().trim().min(1).max(60),
  category_focus: z.array(categoryPath).max(5).default([]),
});
export type CircleCreate = z.infer<typeof CircleCreate>;

export const INVITE_MAX_USES = 200;
export const INVITE_MAX_DAYS = 30;

export const InviteCreate = z.strictObject({
  max_uses: z.number().int().min(1).max(INVITE_MAX_USES).default(25),
  expires_in_days: z.number().int().min(1).max(INVITE_MAX_DAYS).default(14),
});
export type InviteCreate = z.infer<typeof InviteCreate>;

export const Invite = z.object({
  code: z.string(),
  circle_id: z.uuid(),
  max_uses: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  expires_at: z.iso.datetime({ offset: true }),
});
export type Invite = z.infer<typeof Invite>;

/**
 * What the invite landing screen shows before joining ("Jordan invited you to the Thursday
 * Lego Circle"). `status` says whether accepting would work.
 */
export const InvitePreview = z.object({
  code: z.string(),
  circle_name: z.string(),
  inviter_first_name: z.string().nullable(),
  member_count: z.number().int().positive(),
  status: z.enum(["open", "expired", "full", "already_member"]),
});
export type InvitePreview = z.infer<typeof InvitePreview>;
