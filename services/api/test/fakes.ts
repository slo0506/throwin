import { SessionError, type SessionIssuer, type SessionTokens } from "../src/auth/sessions.js";

/** Records calls and returns predictable tokens. */
export class FakeSessionIssuer implements SessionIssuer {
  readonly signIns: { email: string; firstName: string }[] = [];
  fail = false;

  async devSignIn(email: string, firstName: string): Promise<SessionTokens> {
    if (this.fail) throw new SessionError("boom");
    this.signIns.push({ email, firstName });
    return { accessToken: "access", refreshToken: "refresh", expiresAt: 2000000000, userId: "u1" };
  }

  async refresh(refreshToken: string): Promise<SessionTokens> {
    if (refreshToken !== "refresh") throw new SessionError("bad refresh token");
    return {
      accessToken: "access2",
      refreshToken: "refresh2",
      expiresAt: 2000003600,
      userId: "u1",
    };
  }
}
