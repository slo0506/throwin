import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { GmStreamHub } from "./gm/streams.js";
import { appAttest } from "./middleware/app-attest.js";
import { requireAuth } from "./middleware/auth.js";
import { createErrorHandler, notFound } from "./middleware/error-handler.js";
import { idempotency } from "./middleware/idempotency.js";
import { askRoutes } from "./routes/asks.js";
import { authRoutes } from "./routes/auth.js";
import { captureRoutes, mediaRoutes } from "./routes/captures.js";
import { circleRoutes, inviteRoutes } from "./routes/circles.js";
import { gmRoutes } from "./routes/gm.js";
import { healthRoutes } from "./routes/health.js";
import { itemRoutes } from "./routes/items.js";
import { meRoutes } from "./routes/me.js";
import { questionRoutes } from "./routes/questions.js";
import { tasteFactRoutes } from "./routes/taste-facts.js";
import type { AppDeps, AppEnv } from "./types.js";

/** Builds the API with injected dependencies so tests can swap in fakes. */
export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  app.use(requestId({ headerName: "X-Request-Id" }));
  app.onError(createErrorHandler(deps.logger));
  app.notFound(notFound);

  app.route("/", healthRoutes());
  app.route("/auth", authRoutes(deps.sessions, deps.devAuthCode));

  const v1 = new Hono<AppEnv>();
  v1.use(requireAuth(deps.tokens));
  v1.use(appAttest(deps.appAttest.mode, deps.appAttest.verifier, deps.logger));
  v1.use(idempotency(deps.idempotency, deps.logger, now));
  v1.route("/me/taste-facts", tasteFactRoutes(deps.repo));
  v1.route("/me", meRoutes(deps.repo, now));
  v1.route("/asks", askRoutes(deps.repo));
  v1.route("/circles", circleRoutes(deps.repo, now));
  v1.route("/invites", inviteRoutes(deps.repo, now));
  v1.route("/items", itemRoutes(deps.repo, deps.media));
  v1.route("/media", mediaRoutes(deps.repo, deps.media));
  v1.route("/captures", captureRoutes(deps.repo, deps.media));
  v1.route("/questions", questionRoutes(deps.repo, deps.media));
  v1.route(
    "/gm",
    gmRoutes({
      gm: deps.gm ?? null,
      streams: new GmStreamHub(),
      logger: deps.logger,
      ...(deps.gmKeepAliveMs !== undefined && { keepAliveMs: deps.gmKeepAliveMs }),
    }),
  );
  app.route("/v1", v1);

  return app;
}

export type App = ReturnType<typeof createApp>;
