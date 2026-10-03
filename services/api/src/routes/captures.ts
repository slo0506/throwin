import { CaptureRequest, UploadRequest, type UploadResponse } from "@throwin/shared";
import { Hono } from "hono";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import { toCapture } from "../lib/serialize.js";
import type { MediaStore } from "../repo/media.js";
import type { Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";
import { thumbnailUrls } from "./items.js";

/** Storage layout: {user}/{capture}/{n}.jpg. Paths outside the caller's capture are refused. */
const mediaPath = (userId: string, captureId: string, n: number) =>
  `${userId}/${captureId}/${n}.jpg`;

/** POST /v1/media/uploads: opens a capture and returns 1 signed upload URL per file. */
export const mediaRoutes = (repo: Repository, media: MediaStore) =>
  new Hono<AppEnv>().post("/uploads", async (c) => {
    const userId = c.get("user").id;
    const body = await parseJsonBody(c, UploadRequest);
    const capture = await repo.createCapture(userId, body.count, body.kind);
    const uploads = await Promise.all(
      Array.from({ length: body.count }, async (_, n) => {
        const path = mediaPath(userId, capture.id, n);
        return { path, upload_url: await media.createUploadUrl(path) };
      }),
    );
    const response: UploadResponse = { capture_id: capture.id, uploads };
    return c.json(response, 201);
  });

export const captureRoutes = (repo: Repository, media: MediaStore) =>
  new Hono<AppEnv>()
    .post("/", async (c) => {
      const userId = c.get("user").id;
      const body = await parseJsonBody(c, CaptureRequest);
      const prefix = `${userId}/${body.capture_id}/`;
      if (body.media.some((m) => !m.path.startsWith(prefix) || m.path.includes(".."))) {
        throw new HttpError(
          400,
          "invalid_media_path",
          "Media must come from this capture's uploads",
        );
      }
      const existing = await repo.getCapture(userId, body.capture_id);
      if (!existing) throw new HttpError(404, "capture_not_found", "Capture not found");
      if (existing.status !== "uploading") {
        throw new HttpError(409, "capture_submitted", "This capture was already submitted");
      }
      const capture = await repo.submitCapture(userId, body.capture_id, body.media);
      if (!capture) throw new HttpError(404, "capture_not_found", "Capture not found");
      return c.json(toCapture(capture, []), 202);
    })
    .get("/:id", async (c) => {
      const userId = c.get("user").id;
      const capture = await repo.getCapture(userId, c.req.param("id"));
      if (!capture) throw new HttpError(404, "capture_not_found", "Capture not found");
      const items = await repo.listCaptureItems(userId, capture.id);
      return c.json(toCapture(capture, items, await thumbnailUrls(media, items)));
    });
