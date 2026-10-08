import type { Logger } from "./log.js";

const DAY_MS = 86_400_000;

/**
 * The background agents' daily spend cap (docs/setup.md, "Spend caps"). Before claiming a
 * job, each lane asks whether model spend in the last 24 hours is under budget. Over it,
 * jobs wait in the queue, nothing fails or is lost, and they run once the window frees up.
 * Spend is re-read at most once a minute, so a burst can overshoot by about a minute of work.
 */
export class SpendGuard {
  /** Null until the first successful read: the workers don't spend before they know. */
  #open: boolean | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #pending: Promise<void> | null = null;

  constructor(
    private readonly spentSince: (since: Date) => Promise<number>,
    readonly budgetCents: number,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly recheckMs = 60_000,
  ) {}

  /** True while the workers may claim more model work. */
  async allows(): Promise<boolean> {
    if (this.now() - this.#checkedAt >= this.recheckMs) {
      // Lanes ask at once; 1 read answers them all.
      this.#pending ??= this.#refresh().finally(() => {
        this.#pending = null;
      });
      await this.#pending;
    }
    return this.#open === true;
  }

  async #refresh() {
    const now = this.now();
    this.#checkedAt = now;
    try {
      const spent = await this.spentSince(new Date(now - DAY_MS));
      const open = spent < this.budgetCents;
      if (!open && this.#open !== false) {
        this.logger.error("budget_exhausted", {
          spent_cents: spent,
          budget_cents: this.budgetCents,
        });
      } else if (open && this.#open === false) {
        this.logger.info("budget_available", {
          spent_cents: spent,
          budget_cents: this.budgetCents,
        });
      }
      this.#open = open;
    } catch (err) {
      // Keep the last answer and try again next time. With no answer yet, wait.
      this.logger.error("spend_check_failed", { error: String(err) });
    }
  }
}
