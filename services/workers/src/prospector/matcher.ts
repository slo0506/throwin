import { z } from "zod";

// The matcher service's /v1/match, as fixed by docs/contracts/m3-matcher.md.

export interface MatcherEdge {
  from_user: string;
  to_user: string;
  item_id: string;
  utility: number;
  confidence: number;
  kind: "explicit" | "inferred";
  ask_id: string | null;
  giver_ask_id: string | null;
  value_cents: number;
  cash_ceiling_cents: number;
}

export interface MatchRequest {
  edges: MatcherEdge[];
  anchor_user?: string;
  time_limit_seconds?: number;
}

const MatchDeal = z.object({
  users: z.array(z.string()),
  item_legs: z.array(
    z.object({
      giver: z.string(),
      receiver: z.string(),
      item_id: z.string(),
      value_cents: z.number().int(),
      ask_id: z.string().nullable(),
      giver_ask_id: z.string().nullable(),
      kind: z.enum(["explicit", "inferred"]),
    }),
  ),
  cash_legs: z.array(
    z.object({ payer: z.string(), payee: z.string(), amount_cents: z.number().int() }),
  ),
  fairness: z.array(
    z.object({
      user: z.string(),
      gives_cents: z.number().int(),
      gets_cents: z.number().int(),
      cash_in_cents: z.number().int(),
      cash_out_cents: z.number().int(),
      net_cents: z.number().int(),
      tolerance_cents: z.number().int(),
    }),
  ),
  cash_moved_cents: z.number().int(),
  score: z.number(),
});
export type MatchDeal = z.infer<typeof MatchDeal>;

const MatchResponse = z.object({
  deals: z.array(MatchDeal),
  cycles_found: z.number().int(),
  cycles_balanced: z.number().int(),
  truncated: z.boolean(),
  optimal: z.boolean(),
});
export type MatchResponse = z.infer<typeof MatchResponse>;

export interface Matcher {
  match(req: MatchRequest): Promise<MatchResponse>;
}

/** The matcher over HTTP. Its own time limit plus a margin bounds each call. */
export class HttpMatcher implements Matcher {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async match(req: MatchRequest): Promise<MatchResponse> {
    const timeoutMs = ((req.time_limit_seconds ?? 5) + 10) * 1000;
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`matcher ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return MatchResponse.parse(await res.json());
  }
}
