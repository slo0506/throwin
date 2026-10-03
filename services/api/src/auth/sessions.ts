import type { SupabaseClient } from "@supabase/supabase-js";

/** A Supabase session handed to the app. Tokens are opaque to the client. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

/**
 * Issues sessions without Sign in with Apple. Development only: v1 production sign-in is
 * Sign in with Apple through Supabase's native ID-token flow.
 */
export interface SessionIssuer {
  devSignIn(email: string, firstName: string): Promise<SessionTokens>;
  refresh(refreshToken: string): Promise<SessionTokens>;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * Creates the user if needed (email pre-confirmed), then mints a session from a one-time
 * magic-link token server-side, so no email is ever sent and no password exists.
 */
export class SupabaseSessionIssuer implements SessionIssuer {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly anonFactory: () => SupabaseClient,
  ) {}

  async devSignIn(email: string, firstName: string): Promise<SessionTokens> {
    const created = await this.admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { first_name: firstName },
    });
    if (created.error && !/already/i.test(created.error.message)) {
      throw new SessionError(`createUser: ${created.error.message}`);
    }

    const link = await this.admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) {
      throw new SessionError(`generateLink: ${link.error?.message ?? "no token"}`);
    }

    const verified = await this.anonFactory().auth.verifyOtp({
      token_hash: tokenHash,
      type: "email",
    });
    return toTokens(verified.data?.session, verified.error?.message);
  }

  async refresh(refreshToken: string): Promise<SessionTokens> {
    const res = await this.anonFactory().auth.refreshSession({ refresh_token: refreshToken });
    return toTokens(res.data?.session, res.error?.message);
  }
}

function toTokens(
  session:
    | { access_token: string; refresh_token: string; expires_at?: number; user: { id: string } }
    | null
    | undefined,
  error: string | undefined,
): SessionTokens {
  if (!session) throw new SessionError(error ?? "No session returned");
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    userId: session.user.id,
  };
}
