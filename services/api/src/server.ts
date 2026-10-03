import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { createSupabaseVerifier } from "./auth/verifier.js";
import { loadEnv } from "./env.js";
import { createJsonLogger } from "./lib/logger.js";
import { UnimplementedAppAttestVerifier } from "./middleware/app-attest.js";
import { SupabaseRepository } from "./repo/supabase.js";
import { SupabaseIdempotencyStore } from "./repo/supabase-idempotency.js";

const env = loadEnv();
const logger = createJsonLogger(env.LOG_LEVEL);

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = createApp({
  repo: new SupabaseRepository(db),
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
