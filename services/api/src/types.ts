import type { GmService } from "@throwin/harness";
import type { SessionIssuer } from "./auth/sessions.js";
import type { TokenVerifier } from "./auth/verifier.js";
import type { Logger } from "./lib/logger.js";
import type { AppAttestMode, AppAttestVerifier } from "./middleware/app-attest.js";
import type { IdempotencyStore } from "./repo/idempotency.js";
import type { MediaStore } from "./repo/media.js";
import type { Repository } from "./repo/types.js";

export interface AppDeps {
  repo: Repository;
  media: MediaStore;
  idempotency: IdempotencyStore;
  tokens: TokenVerifier;
  sessions: SessionIssuer;
  /** Enables /auth/dev-session when set. Development only. */
  devAuthCode?: string | undefined;
  appAttest: { mode: AppAttestMode; verifier: AppAttestVerifier };
  logger: Logger;
  now?: () => Date;
  /** The GM, run in process. Omitted when no Anthropic key is set: /v1/gm/* answers 503. */
  gm?: GmService | null;
  /** SSE keep-alive interval for /v1/gm/stream, 15 s by default. Tests shorten it. */
  gmKeepAliveMs?: number;
}

export interface AuthUser {
  id: string;
  role: string;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    user: AuthUser;
  };
};
