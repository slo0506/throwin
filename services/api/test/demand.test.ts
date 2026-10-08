import { DemandResponse, NextUpResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, makeHarness } from "./helpers.js";

const ZELDA = "aaaaaaaa-0000-4000-8000-000000000001";
const LEGO = "aaaaaaaa-0000-4000-8000-000000000002";
const ASK = "aaaaaaaa-0000-4000-8000-0000000000a1";

function setup() {
  const h = makeHarness();
  h.repo.addItem({ id: ZELDA, ownerId: ALICE, title: "Zelda: Tears of the Kingdom, Switch" });
  h.repo.addItem({ id: LEGO, ownerId: ALICE, title: "LEGO Batmobile Tumbler" });
  h.repo.demand.set(ALICE, [
    { label: "Nintendo Switch game", category: "video_games", askers: 2, itemIds: [ZELDA] },
    { label: "Nike Kobe 11", category: "sneakers", askers: 3, itemIds: [] },
  ]);
  return h;
}

describe("demand", () => {
  it("lists what people in your Circles want, as counts only", async () => {
    const h = setup();
    const res = await h.request("/v1/demand", { as: ALICE });
    expect(res.status).toBe(200);
    const body = DemandResponse.parse(await res.json());
    expect(body.demand).toEqual([
      { label: "Nintendo Switch game", category: "video_games", askers: 2, your_item_ids: [ZELDA] },
      { label: "Nike Kobe 11", category: "sneakers", askers: 3, your_item_ids: [] },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/user_id|first_name|Bob/);
    const bob = DemandResponse.parse(await (await h.request("/v1/demand", { as: BOB })).json());
    expect(bob.demand).toEqual([]);
  });

  it("suggests trading an Item people want that isn't offered for anything yet", async () => {
    const h = setup();
    const nextUp = async () =>
      NextUpResponse.parse(await (await h.request("/v1/next-up", { as: ALICE })).json()).items;
    expect((await nextUp()).find((i) => i.kind === "in_demand")).toMatchObject({
      title: "Wanted in your Circles: Nintendo Switch game",
      detail: "2 people are looking, and your Zelda: Tears of the Kingdom could fill it.",
      cta: "Trade it",
      item_id: ZELDA,
    });
    // Once Zelda is in an offer, the GM is already on it.
    h.repo.addAsk({ id: ASK, userId: ALICE, status: "prospecting", offerItemIds: [ZELDA] });
    expect((await nextUp()).some((i) => i.kind === "in_demand")).toBe(false);
  });
});
