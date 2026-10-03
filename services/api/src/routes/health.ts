import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const healthRoutes = () =>
  new Hono<AppEnv>().get("/healthz", (c) => c.json({ status: "ok" }));
