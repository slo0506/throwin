import { describe, expect, it } from "vitest";
import { SpendGuard } from "../src/budget.js";
import type { Logger } from "../src/log.js";

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (msg) => lines.push(`info ${msg}`),
    warn: (msg) => lines.push(`warn ${msg}`),
    error: (msg) => lines.push(`error ${msg}`),
  };
  return { logger, lines };
}

function setup(budgetCents = 500) {
  let clock = 1_000_000_000;
  let spent = 0;
  let fail = false;
  const reads: Date[] = [];
  const { logger, lines } = recordingLogger();
  const guard = new SpendGuard(
    async (since) => {
      reads.push(since);
      if (fail) throw new Error("db down");
      return spent;
    },
    budgetCents,
    logger,
    () => clock,
  );
  return {
    guard,
    lines,
    reads,
    advance: (ms: number) => {
      clock += ms;
    },
    spend: (cents: number) => {
      spent = cents;
    },
    failing: (on: boolean) => {
      fail = on;
    },
    now: () => clock,
  };
}

describe("SpendGuard", () => {
  it("reads the last 24 hours of spend, at most once a minute", async () => {
    const t = setup();
    expect(await t.guard.allows()).toBe(true);
    expect(t.reads[0]?.getTime()).toBe(t.now() - 86_400_000);
    await Promise.all([t.guard.allows(), t.guard.allows(), t.guard.allows()]);
    t.advance(59_000);
    await t.guard.allows();
    expect(t.reads).toHaveLength(1);
    t.advance(1_000);
    await t.guard.allows();
    expect(t.reads).toHaveLength(2);
  });

  it("stops at the budget, logs once, and reopens when the window frees up", async () => {
    const t = setup(500);
    t.spend(499.9);
    expect(await t.guard.allows()).toBe(true);
    t.spend(500);
    t.advance(60_000);
    expect(await t.guard.allows()).toBe(false);
    t.advance(60_000);
    expect(await t.guard.allows()).toBe(false);
    expect(t.lines.filter((l) => l === "error budget_exhausted")).toHaveLength(1);
    t.spend(120);
    t.advance(60_000);
    expect(await t.guard.allows()).toBe(true);
    expect(t.lines).toContain("info budget_available");
  });

  it("waits until it knows, and keeps its last answer when a read fails", async () => {
    const t = setup();
    t.failing(true);
    expect(await t.guard.allows()).toBe(false);
    t.failing(false);
    t.advance(60_000);
    expect(await t.guard.allows()).toBe(true);
    t.failing(true);
    t.advance(60_000);
    expect(await t.guard.allows()).toBe(true);
    expect(t.lines.filter((l) => l === "error spend_check_failed")).toHaveLength(2);
  });
});
