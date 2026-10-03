import { createMiddleware } from "hono/factory";
import { HttpError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import type { AppEnv } from "../types.js";

export type AppAttestMode = "off" | "log" | "enforce";

export const APP_ATTEST_HEADER = "X-Apple-AppAttest-Assertion";

export interface AppAttestInput {
  assertion: string;
  userId: string;
  method: string;
  path: string;
}

export interface AppAttestVerifier {
  verifyAssertion(input: AppAttestInput): Promise<boolean>;
}

/**
 * Placeholder until the attestation flow lands.
 * TODO(M0 follow-up): store each device's attested public key (POST /v1/app-attest/attest),
 * then verify assertions here: CBOR-decode, check the signature over
 * authenticatorData || sha256(clientData), the RP ID hash for our App ID, and a strictly
 * increasing counter per key.
 */
export class UnimplementedAppAttestVerifier implements AppAttestVerifier {
  async verifyAssertion(): Promise<boolean> {
    return false;
  }
}

export const appAttest = (mode: AppAttestMode, verifier: AppAttestVerifier, logger: Logger) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (mode === "off") return next();

    const assertion = c.req.header(APP_ATTEST_HEADER);
    const fields = { request_id: c.get("requestId"), path: c.req.path, mode };

    if (!assertion) {
      if (mode === "enforce") {
        throw new HttpError(
          401,
          "app_attest_required",
          "This request needs an App Attest assertion",
        );
      }
      logger.warn("app_attest_missing", fields);
      return next();
    }

    const ok = await verifier.verifyAssertion({
      assertion,
      userId: c.get("user").id,
      method: c.req.method,
      path: c.req.path,
    });
    if (!ok) {
      if (mode === "enforce") {
        throw new HttpError(401, "app_attest_invalid", "App Attest assertion was rejected");
      }
      logger.warn("app_attest_invalid", fields);
    }
    return next();
  });
