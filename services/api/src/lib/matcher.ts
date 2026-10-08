import { z } from "zod";

// The matcher's POST /v1/balance (docs/contracts/m3-matcher.md): the least cash that brings
// everyone in a Deal close to even when its Items are already decided, as a counter does.

export interface BalanceRequest {
  /** Each person and the most cash they'd add (the ceiling of the Ask the Deal fills for them). */
  people: { user: string; cash_ceiling_cents: number }[];
  item_legs: { giver: string; receiver: string; item_id: string; value_cents: number }[];
}

const Fairness = z.object({
  user: z.string(),
  gives_cents: z.number().int(),
  gets_cents: z.number().int(),
  cash_in_cents: z.number().int(),
  cash_out_cents: z.number().int(),
  net_cents: z.number().int(),
  tolerance_cents: z.number().int(),
});

const BalanceResponse = z.object({
  balanced: z.boolean(),
  cash_legs: z.array(
    z.object({ payer: z.string(), payee: z.string(), amount_cents: z.number().int().positive() }),
  ),
  fairness: z.array(Fairness),
  cash_moved_cents: z.number().int(),
});
export type BalanceResult = z.infer<typeof BalanceResponse>;

export interface Balancer {
  balance(req: BalanceRequest): Promise<BalanceResult>;
}

export class HttpBalancer implements Balancer {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async balance(req: BalanceRequest): Promise<BalanceResult> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`matcher ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return BalanceResponse.parse(await res.json());
  }
}
