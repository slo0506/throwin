import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

export const EnvSchema = z
  .object({
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_SECRET: optionalString,
    SUPABASE_JWKS_URL: optionalString.pipe(z.url().optional()),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    APP_ATTEST_MODE: z.enum(["off", "log", "enforce"]).default("off"),
    /** Enables /auth/dev-session. Development only; unset before launch. */
    DEV_AUTH_CODE: optionalString,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** Enables the GM routes. Without it /v1/gm/* answers 503. */
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    /** Folder holding system.md and skills/. Defaults to the nearest agents/gm above the cwd. */
    GM_PROMPT_DIR: optionalString,
  })
  .refine((env) => env.SUPABASE_JWT_SECRET || env.SUPABASE_JWKS_URL, {
    message: "Set SUPABASE_JWT_SECRET, SUPABASE_JWKS_URL, or both",
    path: ["SUPABASE_JWT_SECRET"],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
