/**
 * A hard cap on what 1 eval run may spend on model calls, so a run (or a loop of runs) can
 * never run up a surprise bill. The default is $2; pass --max-cents to change it. A run
 * that hits the cap stops before its next trial and exits as failed.
 */
export const DEFAULT_MAX_CENTS = 200;

export class Budget {
  #spent = 0;

  constructor(readonly maxCents: number) {
    if (!Number.isFinite(maxCents) || maxCents <= 0) {
      throw new Error("--max-cents must be a positive number of cents");
    }
  }

  add(cents: number) {
    this.#spent += cents;
  }

  get spent() {
    return this.#spent;
  }

  get exhausted() {
    return this.#spent >= this.maxCents;
  }

  /** Why the run stopped, for the log. */
  get message() {
    return `Stopped: spent ${this.#spent.toFixed(1)} of the ${this.maxCents} cent budget. Raise it with --max-cents.`;
  }
}

export const parseMaxCents = (raw: string | undefined) =>
  new Budget(raw === undefined ? DEFAULT_MAX_CENTS : Number(raw));
