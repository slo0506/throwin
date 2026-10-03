import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

export interface VerifiedToken {
  userId: string;
  role: string;
  claims: JWTPayload;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export interface SupabaseVerifierOptions {
  /** Legacy HS256 shared secret. */
  jwtSecret?: string;
  /** JWKS for asymmetric signing keys (ES256 or RS256). */
  jwksUrl?: string;
  /** Inject a key resolver, mainly for tests. Takes precedence over jwksUrl. */
  jwks?: JWTVerifyGetKey;
  /** Expected `iss`, usually `${SUPABASE_URL}/auth/v1`. Skipped when undefined. */
  issuer?: string;
  audience?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies Supabase access tokens. HS256 tokens use the shared secret; anything else
 * goes through the JWKS, since newer Supabase projects sign with asymmetric keys.
 */
export function createSupabaseVerifier(options: SupabaseVerifierOptions): TokenVerifier {
  const secret = options.jwtSecret ? new TextEncoder().encode(options.jwtSecret) : undefined;
  const jwks =
    options.jwks ?? (options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined);
  const audience = options.audience ?? "authenticated";

  return {
    async verify(token) {
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        throw new InvalidTokenError("Malformed token");
      }

      let payload: JWTPayload;
      try {
        const common = { audience, ...(options.issuer ? { issuer: options.issuer } : {}) };
        if (alg === "HS256") {
          if (!secret) throw new InvalidTokenError("HS256 tokens are not accepted");
          ({ payload } = await jwtVerify(token, secret, { ...common, algorithms: ["HS256"] }));
        } else {
          if (!jwks)
            throw new InvalidTokenError(`No JWKS configured for ${alg ?? "unknown"} tokens`);
          ({ payload } = await jwtVerify(token, jwks, {
            ...common,
            algorithms: ["ES256", "RS256", "EdDSA"],
          }));
        }
      } catch (err) {
        if (err instanceof InvalidTokenError) throw err;
        throw new InvalidTokenError(err instanceof Error ? err.message : "Invalid token");
      }

      const sub = payload.sub;
      const role = typeof payload.role === "string" ? payload.role : "";
      if (!sub || !UUID.test(sub)) throw new InvalidTokenError("Token has no user subject");
      if (role !== "authenticated") throw new InvalidTokenError("Token is not a user session");
      return { userId: sub, role, claims: payload };
    },
  };
}
