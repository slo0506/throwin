import { describe, expect, it } from "vitest";
import { ALICE, ALICE_ZELDA, lastToolResults, makeWorld, resultText, turn } from "./support.js";

describe("get_demand", () => {
  it("counts what people want, names nobody, and offers the user's Items that fit", async () => {
    const world = await makeWorld([
      { tools: [{ name: "get_demand", input: {} }] },
      (params) => {
        const text = lastToolResults(params).map(resultText).join("");
        expect(text).toContain("wanted by 2 people, category video_games");
        expect(text).toMatch(/untrusted_content[\s\S]*Nintendo Switch game/);
        expect(text).toContain(`id: ${ALICE_ZELDA}`);
        expect(text).toContain("none of the user's Items fit");
        expect(text).not.toMatch(/Bob|user_id/);
        return { text: "2 people in your Circles want a Switch game. Your Zelda could fill it." };
      },
    ]);
    world.data.demand.set(ALICE, [
      { label: "Nintendo Switch game", category: "video_games", askers: 2, itemIds: [ALICE_ZELDA] },
      { label: "Nike Kobe 11", category: "sneakers", askers: 3, itemIds: [] },
    ]);
    const { events } = await turn(world, { text: "What do people around here want?" });
    expect(events.some((e) => e.event === "error")).toBe(false);
  });
});
