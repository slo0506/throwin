import type { TokenVerifier } from "./auth/verifier.js";
import type { Logger } from "./lib/logger.js";
import type { AppAttestMode, AppAttestVerifier } from "./middleware/app-attest.js";
import type { IdempotencyStore } from "./repo/idempotency.js";
import type { Repository } from "./repo/types.js";

export interface AppDeps {
  repo: Repository;
  idempotency: IdempotencyStore;
  tokens: TokenVerifier;
  appAttest: { mode: AppAttestMode; verifier: AppAttestVerifier };
  logger: Logger;
  now?: () => Date;
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
