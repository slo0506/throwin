import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/data.js";
import { ALICE, BOB, makeWorld, NOW, turn } from "./support.js";

const budget = { userDailyCents: 300, dailyCents: 1000 };
let seq = 0;

const spend = (userId: string, costCents: number, agent = "gm"): AgentRun => ({
  id: `run-${++seq}`,
  userId,
  askId: null,
  agent,
  trigger: "turn",
  model: "claude-sonnet-4-6",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costCents,
  latencyMs: 0,
  outcome: "end_turn",
});

describe("GM spend caps", () => {
  it("refuses a turn once the person's GM spend in the last day reaches their cap", async () => {
    const world = await makeWorld([{ text: "Hi Alice." }], { budget });
    await world.data.recordRun(spend(ALICE, 299));
    // Background agents have their own cap; they never count against GM chat.
    await world.data.recordRun(spend(ALICE, 500, "appraiser.price.research"));
    await turn(world, { text: "hi" });

    await world.data.recordRun(spend(ALICE, 1));
    const before = world.data.messages.length;
    await expect(world.gm.prepareTurn(ALICE, { text: "one more" })).rejects.toMatchObject({
      status: 429,
      code: "gm_daily_limit",
      message: "You've reached today's limit with your GM. Try again tomorrow.",
    });
    // Refused before anything was stored.
    expect(world.data.messages).toHaveLength(before);
  });

  it("only counts the last 24 hours", async () => {
    const world = await makeWorld([{ text: "Hi Alice." }], { budget });
    world.data.now = () => new Date(NOW.getTime() - 25 * 3_600_000);
    await world.data.recordRun(spend(ALICE, 5000));
    world.data.now = () => NOW;
    await expect(turn(world, { text: "hi" })).resolves.toBeDefined();
  });

  it("pauses every GM once everyone's spend reaches the shared cap", async () => {
    const world = await makeWorld([], { budget });
    await world.data.recordRun(spend(BOB, 1000));
    await expect(world.gm.prepareTurn(ALICE, { text: "hi" })).rejects.toMatchObject({
      status: 429,
      code: "gm_paused",
    });
  });

  it("doesn't cap turns without a budget", async () => {
    const world = await makeWorld([{ text: "Hi Alice." }]);
    await world.data.recordRun(spend(ALICE, 100_000));
    await expect(turn(world, { text: "hi" })).resolves.toBeDefined();
  });
});
