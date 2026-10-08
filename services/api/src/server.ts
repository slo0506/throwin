import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import {
  AnthropicModelClient,
  braveImageSearch,
  findPromptDir,
  GmService,
  loadGmPrompts,
  SupabaseGmData,
} from "@throwin/harness";
import { createApp } from "./app.js";
import { SupabaseSessionIssuer } from "./auth/sessions.js";
import { createSupabaseVerifier } from "./auth/verifier.js";
import { loadEnv } from "./env.js";
import { createJsonLogger } from "./lib/logger.js";
import { UnimplementedAppAttestVerifier } from "./middleware/app-attest.js";
import { SupabaseMediaStore } from "./repo/media.js";
import { SupabaseRepository } from "./repo/supabase.js";
import { SupabaseIdempotencyStore } from "./repo/supabase-idempotency.js";

const env = loadEnv();
const logger = createJsonLogger(env.LOG_LEVEL);

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = () =>
  createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// The GM runs in process. Prompts load once at boot; without a key the GM routes answer 503.
const gm = env.ANTHROPIC_API_KEY
  ? new GmService({
      data: new SupabaseGmData(db),
      model: AnthropicModelClient.fromApiKey(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MAX_RETRIES),
      prompts: await loadGmPrompts(env.GM_PROMPT_DIR ?? findPromptDir()),
      logger,
      budget: {
        userDailyCents: env.GM_USER_DAILY_BUDGET_CENTS,
        dailyCents: env.GM_DAILY_BUDGET_CENTS,
      },
      ...(env.BRAVE_SEARCH_API_KEY && {
        imageSearch: (query: string) => braveImageSearch(query, env.BRAVE_SEARCH_API_KEY as string),
      }),
    })
  : null;
if (gm) {
  logger.info("gm_ready", {
    prompt_version: gm.promptVersion,
    product_images: env.BRAVE_SEARCH_API_KEY ? "brave" : "pages_only",
    user_daily_budget_cents: env.GM_USER_DAILY_BUDGET_CENTS,
    daily_budget_cents: env.GM_DAILY_BUDGET_CENTS,
  });
} else logger.warn("gm_disabled", { reason: "ANTHROPIC_API_KEY is not set" });

const app = createApp({
  gm,
  sessions: new SupabaseSessionIssuer(db, anonClient),
  devAuthCode: env.DEV_AUTH_CODE,
  repo: new SupabaseRepository(db),
  media: new SupabaseMediaStore(db),
  idempotency: new SupabaseIdempotencyStore(db),
  tokens: createSupabaseVerifier({
    ...(env.SUPABASE_JWT_SECRET && { jwtSecret: env.SUPABASE_JWT_SECRET }),
    ...(env.SUPABASE_JWKS_URL && { jwksUrl: env.SUPABASE_JWKS_URL }),
    issuer: `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`,
  }),
  appAttest: { mode: env.APP_ATTEST_MODE, verifier: new UnimplementedAppAttestVerifier() },
  logger,
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  logger.info("api_listening", { port: info.port, app_attest_mode: env.APP_ATTEST_MODE });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("api_shutdown", { signal });
    server.close(() => process.exit(0));
  });
}
