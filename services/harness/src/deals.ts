import type { CounterCardData, CounterChange, DealSheet } from "@throwin/shared";

/**
 * Deals and counters, as the GM reaches them. The API implements this over its repository
 * and the matcher, so the GM sees exactly what the user's Deal Sheets show and plans
 * counters with the same checks the counter route runs. Nothing here sends or decides.
 */
export interface DealDesk {
  /** The user's Deals waiting on approvals or answers, from their side. */
  list(userId: string): Promise<DealSheet[]>;
  /** What a counter would do, without sending it, or why it can't go out. */
  preview(
    userId: string,
    dealId: string,
    changes: CounterChange[],
  ): Promise<CounterCardData | { problem: string; message: string }>;
}
