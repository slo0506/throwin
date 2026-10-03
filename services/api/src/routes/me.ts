import { type DeleteMeResponse, PatchMe } from "@throwin/shared";
import { Hono } from "hono";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import { toMe } from "../lib/serialize.js";
import type { MeRecord, Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

/** Soft-deleted accounts are hard-deleted by a worker within this window (PRD: 30 days). */
export const HARD_DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function requireLive(record: MeRecord | null): MeRecord {
  if (!record) throw new HttpError(404, "user_not_found", "No account for this session");
  if (record.deletedAt) {
    throw new HttpError(410, "account_deleted", "This account is scheduled for deletion");
  }
  return record;
}

export const meRoutes = (repo: Repository, now: () => Date) =>
  new Hono<AppEnv>()
    .get("/", async (c) => {
      const me = requireLive(await repo.getMe(c.get("user").id));
      return c.json(toMe(me));
    })
    .patch("/", async (c) => {
      const userId = c.get("user").id;
      requireLive(await repo.getMe(userId));
      const body = await parseJsonBody(c, PatchMe);
      const updated = await repo.updateMe(userId, {
        ...(body.display_name !== undefined && { displayName: body.display_name }),
        ...(body.photo_url !== undefined && { photoUrl: body.photo_url }),
        ...(body.autonomy_level !== undefined && { autonomyLevel: body.autonomy_level }),
        ...(body.notification_prefs !== undefined && {
          notificationPrefs: body.notification_prefs,
        }),
      });
      return c.json(toMe(requireLive(updated)));
    })
    .delete("/", async (c) => {
      const deletedAt = await repo.softDeleteUser(c.get("user").id, now());
      if (!deletedAt) throw new HttpError(404, "user_not_found", "No account for this session");
      const body: DeleteMeResponse = {
        status: "scheduled",
        hard_delete_after: new Date(deletedAt.getTime() + HARD_DELETE_AFTER_MS).toISOString(),
      };
      return c.json(body, 202);
    });
