import { NextUpResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, makeHarness } from "./helpers.js";

const ITEM = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const ASK = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
const DEAL = (n: number) => `dddddddd-0000-4000-8000-00000000000${n}`;

const ps4 = {
  kind: "exact" as const,
  name: "PlayStation 4 Pro",
  brand: "Sony",
  model: null,
  category: "electronics/consoles",
  constraints: [],
  anchor: { retail_cents: 39900, used_low_cents: 10000, used_high_cents: 15000 },
  image_url: "https://img.example.com/ps4.jpg",
};

async function nextUp(h: ReturnType<typeof makeHarness>) {
  const res = await h.request("/v1/next-up", { as: ALICE });
  expect(res.status).toBe(200);
  return NextUpResponse.parse(await res.json()).items;
}

describe("GET /v1/next-up", () => {
  it("starts a new user with the Shelf and a first Ask", async () => {
    const h = makeHarness();
    expect((await nextUp(h)).map((i) => i.kind)).toEqual(["add_to_shelf", "new_ask"]);
  });

  it("ranks what's at stake: a Deal, then photos someone waits on, then the user's homework", async () => {
    const h = makeHarness();
    const { repo } = h;
    repo.addItem({
      id: ITEM(1),
      ownerId: ALICE,
      title: "Crocs Classic Clog, navy",
      valueLowCents: 1500,
      valueMidCents: 2000,
      valueHighCents: 2500,
      readiness: "identified",
      missingAngles: ["Both soles", "Size tag"],
    });
    repo.addItem({
      id: ITEM(2),
      ownerId: ALICE,
      title: "Zelda: Tears of the Kingdom",
      valueLowCents: 3500,
      valueMidCents: 4000,
      valueHighCents: 4500,
      readiness: "showcase",
    });
    repo.addQuestion({ id: "q1", itemId: ITEM(2) });
    repo.addQuestion({ id: "q2", itemId: ITEM(2), prompt: "Is the case included?" });
    repo.addItem({ id: ITEM(3), ownerId: BOB, title: "Galaxy Explorer", readiness: "showcase" });
    repo.addItem({
      id: ITEM(4),
      ownerId: ALICE,
      title: "LEGO Typewriter",
      readiness: "logged",
      missingAngles: ["Front"],
    });
    repo.addItem({ id: ITEM(5), ownerId: BOB, title: "Mario Wonder", readiness: "showcase" });
    // A long-shot offer, an Ask with nothing offered, and the Deals.
    repo.addAsk({
      id: ASK(1),
      userId: ALICE,
      status: "prospecting",
      title: "PlayStation 4 Pro",
      target: ps4,
      offerItemIds: [ITEM(1)],
    });
    repo.addAsk({ id: ASK(2), userId: ALICE, status: "offering", target: ps4, title: "PS4" });
    repo.addDeal({
      id: DEAL(1),
      expiresAt: new Date("2026-10-04T08:00:00Z"),
      legs: [
        { giverId: BOB, receiverId: ALICE, itemId: ITEM(3) },
        { giverId: ALICE, receiverId: BOB, itemId: ITEM(2) },
      ],
    });
    repo.addDeal({
      id: DEAL(2),
      status: "staged",
      expiresAt: new Date("2026-10-04T00:00:00Z"),
      legs: [
        { giverId: BOB, receiverId: ALICE, itemId: ITEM(5) },
        { giverId: ALICE, receiverId: BOB, itemId: ITEM(4) },
      ],
    });

    const items = await nextUp(h);
    expect(items.map((i) => i.kind)).toEqual([
      "approve_deal",
      "showcase_photos",
      "offer_for_ask",
      "join_circle",
      "weak_offer",
      "tune_up",
    ]);
    const [deal, photos, offer, , fit, tune] = items;
    expect(deal).toMatchObject({
      title: "Bob's Galaxy Explorer for your Zelda: Tears of the Kingdom",
      detail: "Waiting on you. Expires in 20 hours.",
      deal_id: DEAL(1),
    });
    expect(photos).toMatchObject({
      title: "Bob wants your LEGO Typewriter",
      detail: "1 photo and the deal can go out. Held for 12 hours.",
      item_id: ITEM(4),
      angles: ["Front"],
    });
    expect(offer).toMatchObject({ ask_id: ASK(2), title: "Pick what you'd give up for PS4" });
    expect(fit).toMatchObject({
      ask_id: ASK(1),
      title: "Your PlayStation 4 Pro offer is a long shot",
      detail: "Your best is worth about $15 to $25, and it goes for $100 to $150.",
    });
    expect(tune).toMatchObject({ title: "Answer 2 quick questions" });
    // Never another person's limits or anything about their Ask.
    expect(JSON.stringify(items)).not.toMatch(/cash_ceiling|ceiling/);
  });
});
