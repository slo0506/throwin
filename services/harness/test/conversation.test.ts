import type Anthropic from "@anthropic-ai/sdk";
import { GmConversation } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { GmInputError } from "../src/service.js";
import {
  ALICE,
  ALICE_LEGO,
  ALICE_ZELDA,
  BOB_ITEM,
  idFromLastResult,
  lastToolResults,
  makeWorld,
  resultText,
  sessionBlockOf,
  turn,
} from "./support.js";

const RECAP = {
  paragraph:
    "You're into LEGO Star Wars and Switch games, hunting for the Batmobile, and the Falcon stays home.",
  sample_decisions: [
    {
      give_item_id: ALICE_ZELDA,
      get: "the Batmobile Tumbler",
      verdict: "yes",
      why: "You said Zelda is done.",
    },
    {
      give: "2 Switch games",
      get: "a sealed Batmobile",
      verdict: "yes",
      why: "Games for LEGO fits you.",
    },
    {
      give_item_id: ALICE_LEGO,
      get: "the Batmobile Tumbler",
      verdict: "no",
      why: "The Falcon stays home.",
    },
  ],
};

describe("GET conversation", () => {
  it("creates the conversation in intake mode with the greeting", async () => {
    const world = await makeWorld();
    const convo = GmConversation.parse(await world.gm.getConversation(ALICE));
    expect(convo.mode).toBe("intake");
    expect(convo.messages).toHaveLength(1);
    expect(convo.messages[0]).toMatchObject({ role: "assistant", components: [] });
    expect(convo.messages[0]?.text).toMatch(/^Hi Alice, I'm your GM\./);
    expect(convo.messages[0]?.text).not.toContain("{first_name}");
    // Same conversation on the next call.
    expect((await world.gm.getConversation(ALICE)).conversation_id).toBe(convo.conversation_id);
    expect(world.data.conversations).toHaveLength(1);
  });

  it("puts the intake guide in the session block only while intake runs", async () => {
    const world = await makeWorld([{ text: "Nice." }]);
    await turn(world, { text: "I like LEGO" });
    const session = sessionBlockOf(world.model.requests[0]);
    expect(session).toContain("Conversation mode: intake");
    expect(session).toContain("<intake_guide>");
    expect(session).toContain("What's 1 thing you want right now?");
  });

  it("rebuilds history from stored tool calls, with fresh data and the user's picks", async () => {
    const world = await makeWorld([
      {
        text: "Which would you offer?",
        tools: [
          {
            name: "present_items",
            input: { item_ids: [ALICE_LEGO, ALICE_ZELDA], selectable: true },
          },
        ],
      },
      { text: "" },
    ]);
    const first = await turn(world, { text: "What could I offer?" });
    const cardId = first.events.find((e) => e.event === "component")?.data as { id: string };
    world.model.push({ text: "Got it, Zelda it is." });
    await turn(world, { choice: { component_id: cardId.id, option_ids: [ALICE_ZELDA] } });
    // The model saw the pick with the Item's title and ID.
    const picked = world.model.requests.at(-1)?.messages.at(-1)
      ?.content as Anthropic.ContentBlockParam[];
    const pickText = picked.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(pickText).toContain(`${ALICE_ZELDA}: Zelda: Tears of the Kingdom (Switch) (their own)`);

    // Values changed since the card was shown: history shows today's values.
    const zelda = world.data.items.find((i) => i.id === ALICE_ZELDA);
    if (zelda) zelda.valueHighCents = 5000;

    const convo = GmConversation.parse(await world.gm.getConversation(ALICE));
    expect(convo.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      expect.stringMatching(/^assistant:Hi Alice/),
      "user:What could I offer?",
      "assistant:Which would you offer?",
      "user:Zelda: Tears of the Kingdom (Switch)",
      "assistant:Got it, Zelda it is.",
    ]);
    const card = convo.messages[2]?.components[0];
    expect(card?.id).toBe(cardId.id);
    expect(card?.kind).toBe("item_cards");
    if (card?.kind === "item_cards") {
      expect(card.data.selected_ids).toEqual([ALICE_ZELDA]);
      expect(card.data.items.find((i) => i.id === ALICE_ZELDA)?.value?.high_cents).toBe(5000);
    }
  });

  it("rejects a choice for a card that isn't in the conversation or an option it never had", async () => {
    const world = await makeWorld([
      {
        tools: [
          {
            name: "present_choices",
            input: {
              prompt: "How hands-off?",
              options: [
                { id: "every_deal", label: "Bring me every deal" },
                { id: "likely_yes", label: "Only likely yeses" },
              ],
            },
          },
        ],
      },
      { text: "" },
    ]);
    const { events } = await turn(world, { text: "hi" });
    const card = events.find((e) => e.event === "component")?.data as { id: string };

    await expect(
      world.gm.prepareTurn(ALICE, { choice: { component_id: "nope", option_ids: ["every_deal"] } }),
    ).rejects.toMatchObject({ code: "unknown_component", status: 400 });
    await expect(
      world.gm.prepareTurn(ALICE, {
        choice: { component_id: card.id, option_ids: ["approve_deal"] },
      }),
    ).rejects.toBeInstanceOf(GmInputError);

    world.model.push({ text: "Every deal it is." });
    await turn(world, { choice: { component_id: card.id, option_ids: ["likely_yes"] } });
    const convo = await world.gm.getConversation(ALICE);
    expect(convo.messages.at(-2)?.text).toBe("Only likely yeses");
    expect(convo.messages[2]?.components[0]).toMatchObject({
      kind: "choices",
      data: { prompt: "How hands-off?" },
    });
  });

  it("accepts the recap card's chips as an answer", async () => {
    const world = await makeWorld([
      { tools: [{ name: "present_recap", input: RECAP }] },
      { text: "" },
    ]);
    const { events } = await turn(world, { text: "recap" });
    const recap = events.find((e) => e.event === "component")?.data as { id: string };
    await expect(
      world.gm.prepareTurn(ALICE, { choice: { component_id: recap.id, option_ids: ["approve"] } }),
    ).rejects.toMatchObject({ code: "invalid_choice", status: 400 });

    world.model.push({ text: "Great." });
    await turn(world, { choice: { component_id: recap.id, option_ids: ["looks_right"] } });
    const convo = await world.gm.getConversation(ALICE);
    expect(convo.messages.at(-2)?.text).toBe("Looks right");
    const sent = JSON.stringify(world.model.requests.at(-1)?.messages.at(-1));
    expect(sent).toContain(`tapped \\"Looks right\\" on the recap card ${recap.id}`);
  });

  it("shows at most 1 question card per turn", async () => {
    const question = {
      name: "present_choices",
      input: {
        prompt: "How should I handle deals I find?",
        options: [
          { id: "every_deal", label: "Bring me every deal" },
          { id: "likely_yes", label: "Only likely yeses" },
        ],
      },
    };
    const world = await makeWorld([{ tools: [question] }, { tools: [question] }, { text: "" }]);
    const { events } = await turn(world, { text: "hi" });
    expect(events.filter((e) => e.event === "component")).toHaveLength(1);
    const second = resultText(
      lastToolResults(
        world.model.requests[2] as Anthropic.MessageCreateParamsNonStreaming,
      )[0] as Anthropic.ToolResultBlockParam,
    );
    expect(second).toMatch(/already asked a question/);
    // The next turn may ask again.
    world.model.push({ tools: [question] }, { text: "" });
    const next = await turn(world, { text: "ok" });
    expect(next.events.filter((e) => e.event === "component")).toHaveLength(1);
  });

  it("rejects media paths outside the user's own uploads", async () => {
    const world = await makeWorld();
    await expect(
      world.gm.prepareTurn(ALICE, { media_paths: ["someone-else/items/x.jpg"] }),
    ).rejects.toMatchObject({ code: "invalid_media_path" });
    await expect(
      world.gm.prepareTurn(ALICE, { media_paths: [`${ALICE}/../x.jpg`] }),
    ).rejects.toMatchObject({ code: "invalid_media_path" });
  });
});

describe("intake", () => {
  it("won't finish without an Ask and a recap, then switches to chat", async () => {
    const world = await makeWorld([
      { tools: [{ name: "finish_intake", input: {} }] },
      { text: "Let's make your first Ask." },
    ]);
    await turn(world, { text: "skip this" });
    expect(
      resultText(
        lastToolResults(
          world.model.requests[1] as Anthropic.MessageCreateParamsNonStreaming,
        )[0] as Anthropic.ToolResultBlockParam,
      ),
    ).toMatch(/no Ask yet/);
    expect((await world.gm.getConversation(ALICE)).mode).toBe("intake");

    world.model.push(
      { tools: [{ name: "resolve_target", input: { text: "batmobile" } }] },
      (params) => ({
        tools: [
          {
            name: "upsert_ask",
            input: { raw_text: "batmobile", target_id: idFromLastResult(params, "target_id") },
          },
        ],
      }),
      { tools: [{ name: "finish_intake", input: {} }] },
      { tools: [{ name: "present_recap", input: RECAP }] },
      { tools: [{ name: "finish_intake", input: {} }] },
      { text: "You're all set. I'll ping you when I find a deal." },
    );
    const { events } = await turn(world, { text: "I want the Batmobile" });
    const results = world.model.requests
      .slice(-4)
      .map((r) => resultText(lastToolResults(r)[0] as Anthropic.ToolResultBlockParam));
    expect(results[1]).toMatch(/Show the recap with present_recap first/);
    expect(results[3]).toMatch(/Intake finished/);

    const recap = events.find((e) => e.event === "component" && e.data.kind === "recap");
    expect(recap?.data).toMatchObject({
      kind: "recap",
      data: {
        sample_decisions: [
          { give: "Zelda: Tears of the Kingdom (Switch)", verdict: "yes" },
          { give: "2 Switch games" },
          { give: "LEGO Millennium Falcon 75257", verdict: "no" },
        ],
      },
    });

    const convo = GmConversation.parse(await world.gm.getConversation(ALICE));
    expect(convo.mode).toBe("chat");
    expect(world.data.asks).toHaveLength(1);

    // The next turn runs in chat mode without the intake guide.
    world.model.push({ text: "Hey again." });
    await turn(world, { text: "hi" });
    const session = sessionBlockOf(world.model.requests.at(-1));
    expect(session).toContain("Conversation mode: chat");
    expect(session).not.toContain("<intake_guide>");
  });

  it("refuses a recap that quotes a price no tool showed", async () => {
    const world = await makeWorld([
      {
        tools: [
          {
            name: "present_recap",
            input: { ...RECAP, paragraph: "Your Falcon is worth $999 easy, and Zelda about $40." },
          },
        ],
      },
      { text: "Let me fix that." },
    ]);
    await turn(world, { text: "recap please" });
    const text = resultText(
      lastToolResults(
        world.model.requests[1] as Anthropic.MessageCreateParamsNonStreaming,
      )[0] as Anthropic.ToolResultBlockParam,
    );
    // $40 sits inside Zelda's $35 to $45, but only amounts a tool or the session showed count.
    expect(text).toMatch(/mentions \$999, \$40/);
    expect(world.data.events.find((e) => e.type === "tool_call")?.payload).toMatchObject({
      ok: false,
      error_code: "ungrounded_price",
    });
  });
});

describe("offers", () => {
  it("sets an offer set and cash ceiling, moving the Ask to prospecting", async () => {
    const world = await makeWorld([
      { tools: [{ name: "resolve_target", input: { text: "batmobile" } }] },
      (params) => ({
        tools: [
          {
            name: "upsert_ask",
            input: { raw_text: "batmobile", target_id: idFromLastResult(params, "target_id") },
          },
        ],
      }),
      (params) => ({
        tools: [
          {
            name: "set_offer_set",
            input: {
              ask_id: idFromLastResult(params, "ask_id"),
              item_ids: [ALICE_ZELDA, ALICE_LEGO],
              cash_ceiling_cents: 2000,
            },
          },
        ],
      }),
      (params) => ({
        tools: [{ name: "present_ask", input: { ask_id: idFromLastResult(params, "ask_id") } }],
      }),
      { text: "On it." },
    ]);
    const { events } = await turn(world, { text: "Batmobile for my Zelda and Falcon, up to $20" });
    expect(world.data.asks[0]).toMatchObject({
      status: "prospecting",
      offerItemIds: [ALICE_ZELDA, ALICE_LEGO],
      cashCeilingCents: 2000,
    });
    const summary = world.data.events.find((e) => e.payload.tool === "set_offer_set")?.summary;
    expect(summary).toBe(
      "Set your offer for LEGO Batman Batmobile Tumbler 76240: 2 Items, up to $20 cash",
    );
    const card = events.find((e) => e.event === "component")?.data;
    expect(card).toMatchObject({
      kind: "ask_card",
      data: {
        status: "prospecting",
        status_line: "Checking 1 Shelf in 1 Circle",
        offer_value: { low_cents: 12500, high_cents: 17500 },
        cash_ceiling_cents: 2000,
        title: "LEGO Batman Batmobile Tumbler 76240",
      },
    });
  });

  it("tells the GM exactly which Items were just added, and lets it use them right away", async () => {
    const world = await makeWorld();
    const ask = await world.data.createAsk(ALICE, {
      rawText: "a PS4",
      title: null,
      target: null,
      status: "offering",
      autonomy: "every_deal",
      deadline: null,
    });
    world.model.push(
      {
        tools: [
          {
            name: "set_offer_set",
            input: { ask_id: ask.id, item_ids: [ALICE_ZELDA], cash_ceiling_cents: 0 },
          },
        ],
      },
      { text: "Added it to the offer." },
    );
    // The Ask's ID comes from the session block; the Item's only from added_item_ids.
    await turn(world, { text: "I added Zelda to my Shelf.", added_item_ids: [ALICE_ZELDA] });
    const first = world.model.requests[0];
    const sent = JSON.stringify(first?.messages.at(-1)?.content);
    expect(sent).toContain(`${ALICE_ZELDA}: Zelda: Tears of the Kingdom (Switch)`);
    expect(ask.offerItemIds).toEqual([ALICE_ZELDA]);
    const stored = world.data.messages.find((m) => m.role === "user");
    expect(stored?.toolCalls).toMatchObject({ added_item_ids: [ALICE_ZELDA] });
  });

  it("refuses added Items that aren't the user's", async () => {
    const world = await makeWorld();
    await expect(
      world.gm.prepareTurn(ALICE, { text: "I added this", added_item_ids: [BOB_ITEM] }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_item" });
  });

  it("saves which deals to bring on the profile and every open Ask, never per Ask", async () => {
    const world = await makeWorld();
    const open = await world.data.createAsk(ALICE, {
      rawText: "x",
      title: null,
      target: null,
      status: "offering",
      autonomy: "every_deal",
      deadline: null,
    });
    const done = await world.data.createAsk(ALICE, {
      rawText: "y",
      title: null,
      target: null,
      status: "fulfilled",
      autonomy: "every_deal",
      deadline: null,
    });
    world.model.push(
      { tools: [{ name: "set_autonomy", input: { level: "likely_yes" } }] },
      { text: "Done." },
    );
    await turn(world, { text: "only bring me deals I'd take" });
    expect((await world.data.getUser(ALICE))?.autonomy).toBe("likely_yes");
    expect([open.autonomy, done.autonomy]).toEqual(["likely_yes", "every_deal"]);
    // New Asks inherit it: upsert_ask has no autonomy field to override it with.
    const upsert = world.gm.registry.definitions().find((d) => d.name === "upsert_ask");
    expect(JSON.stringify(upsert?.input_schema)).not.toContain("autonomy");
  });

  it("refuses cash ceilings over $1,000 and Items marked not available", async () => {
    const world = await makeWorld();
    const ask = await world.data.createAsk(ALICE, {
      rawText: "x",
      title: null,
      target: null,
      status: "offering",
      autonomy: "every_deal",
      deadline: null,
    });
    const falcon = world.data.items.find((i) => i.id === ALICE_LEGO);
    if (falcon) falcon.willingness = "not_available";
    world.model.push(
      {
        tools: [
          {
            name: "set_offer_set",
            input: { ask_id: ask.id, item_ids: [], cash_ceiling_cents: 100001 },
          },
        ],
      },
      {
        tools: [
          {
            name: "set_offer_set",
            input: { ask_id: ask.id, item_ids: [ALICE_LEGO], cash_ceiling_cents: 0 },
          },
        ],
      },
      { text: "ok" },
    );
    await turn(world, { text: "offer" });
    const [tooMuch, notAvailable] = world.model.requests
      .slice(1, 3)
      .map((r) => resultText(lastToolResults(r)[0] as Anthropic.ToolResultBlockParam));
    expect(tooMuch).toMatch(/cash_ceiling_cents/);
    expect(notAvailable).toMatch(/marked not available/);
    expect(ask.offerItemIds).toEqual([]);
  });

  it("surfaces the write path's offer rules when an Item is taken after the check", async () => {
    const world = await makeWorld();
    const ask = await world.data.createAsk(ALICE, {
      rawText: "x",
      title: null,
      target: null,
      status: "offering",
      autonomy: "every_deal",
      deadline: null,
    });
    // A Deal reserves Zelda between set_offer_set's own check and patch_ask.
    const update = world.data.updateAsk.bind(world.data);
    world.data.updateAsk = async (userId, askId, patch) => {
      const zelda = world.data.items.find((i) => i.id === ALICE_ZELDA);
      if (zelda) zelda.reserved = true;
      return update(userId, askId, patch);
    };
    world.model.push(
      {
        tools: [
          {
            name: "set_offer_set",
            input: { ask_id: ask.id, item_ids: [ALICE_ZELDA], cash_ceiling_cents: 500 },
          },
        ],
      },
      { text: "ok" },
    );
    await turn(world, { text: "offer Zelda" });
    const [result] = world.model.requests
      .slice(1, 2)
      .map((r) => resultText(lastToolResults(r)[0] as Anthropic.ToolResultBlockParam));
    expect(result).toMatch(/no longer the user's, on the Shelf and free/);
    expect(ask).toMatchObject({ status: "offering", offerItemIds: [], cashCeilingCents: 0 });
  });

  it("never turns a want Throw-In can't trade into an Ask", async () => {
    const world = await makeWorld();
    world.resolver.target = {
      ...world.resolver.target,
      name: "Golden retriever puppy",
      category: "pets",
      anchor: null,
      prohibited_reason: "live_animal",
    };
    world.model.push(
      { tools: [{ name: "resolve_target", input: { text: "a golden retriever puppy" } }] },
      { text: "Throw-In can't trade live animals." },
    );
    await turn(world, { text: "I want a golden retriever puppy" });
    const result = resultText(
      lastToolResults(
        world.model.requests[1] as Anthropic.MessageCreateParamsNonStreaming,
      )[0] as Anthropic.ToolResultBlockParam,
    );
    expect(result).toContain("Throw-In can't trade live animals.");
    // No target_id is issued, so there is nothing for upsert_ask to use.
    expect(result).not.toMatch(/target_id/);
    expect(await world.data.listActiveAsks(ALICE)).toEqual([]);
  });

  it("moves a drafting Ask to offering when upsert_ask adds a target", async () => {
    const world = await makeWorld();
    const ask = await world.data.createAsk(ALICE, {
      rawText: "something batman",
      title: null,
      target: null,
      status: "drafting",
      autonomy: "every_deal",
      deadline: null,
    });
    world.model.push(
      { tools: [{ name: "resolve_target", input: { text: "batmobile" } }] },
      (params) => ({
        tools: [
          {
            name: "upsert_ask",
            input: { ask_id: ask.id, target_id: idFromLastResult(params, "target_id") },
          },
        ],
      }),
      { text: "ok" },
    );
    await turn(world, { text: "the Batmobile Tumbler" });
    expect(ask).toMatchObject({
      status: "offering",
      title: "LEGO Batman Batmobile Tumbler 76240",
    });
  });
});
