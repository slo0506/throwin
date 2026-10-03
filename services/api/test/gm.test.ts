import { fileURLToPath } from "node:url";
import {
  type CreateParams,
  FakeModelClient,
  type FakeStep,
  GmService,
  loadGmPrompts,
  MemoryGmData,
  type ModelClient,
} from "@throwin/harness";
import { GmConversation, PostGmMessageResponse } from "@throwin/shared";
import { describe, expect, it } from "vitest";
import { GmStreamHub } from "../src/gm/streams.js";
import { ALICE, BOB, errorCode, makeHarness } from "./helpers.js";

const ALICE_ITEM = "aaaaaaaa-0000-4000-8000-000000000001";
const promptDir = fileURLToPath(new URL("../../../agents/gm", import.meta.url));

/** Holds every model call until `open()`, so a turn can be caught mid-flight. */
class GatedModel implements ModelClient {
  #open!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.#open = resolve;
  });
  constructor(readonly inner: FakeModelClient) {}
  open() {
    this.#open();
  }
  async stream(params: CreateParams, onText: (delta: string) => void) {
    await this.gate;
    return this.inner.stream(params, onText);
  }
  async create(params: CreateParams) {
    await this.gate;
    return this.inner.create(params);
  }
}

async function setup(steps: FakeStep[] = [], opts: { gated?: boolean; keepAliveMs?: number } = {}) {
  const data = new MemoryGmData();
  data.addUser(ALICE, { firstName: "Alice" });
  data.addUser(BOB, { firstName: "Bob" });
  data.addItem({
    id: ALICE_ITEM,
    ownerId: ALICE,
    title: "LEGO Millennium Falcon",
    valueLowCents: 9000,
    valueMidCents: 11000,
    valueHighCents: 13000,
  });
  const fake = new FakeModelClient(steps);
  const model = opts.gated ? new GatedModel(fake) : fake;
  const gm = new GmService({ data, model, prompts: await loadGmPrompts(promptDir) });
  const h = makeHarness({ gm, gmKeepAliveMs: opts.keepAliveMs ?? 15_000 });
  return { ...h, data, fake, model };
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Splits an SSE body into events and comment lines. */
function parseSse(body: string): { events: SseEvent[]; comments: string[] } {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  for (const chunk of body.split("\n\n")) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    if (lines.every((l) => l.startsWith(":"))) {
      comments.push(...lines);
      continue;
    }
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
    const data = lines
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("\n");
    events.push({ event, data: JSON.parse(data) });
  }
  return { events, comments };
}

const post = (
  request: ReturnType<typeof makeHarness>["request"],
  body: unknown,
  as = ALICE,
  headers: Record<string, string> = {},
) => request("/v1/gm/messages", { method: "POST", as, body: JSON.stringify(body), headers });

describe("GM routes", () => {
  it("streams a turn as server-sent events in the contract format", async () => {
    const { request } = await setup([
      { text: "Let me check.", tools: [{ name: "search_my_shelf", input: {} }] },
      { tools: [{ name: "present_items", input: { item_ids: [ALICE_ITEM] } }] },
      { text: "That's your Falcon." },
    ]);
    const res = await post(request, { text: "What do I have?" });
    expect(res.status).toBe(202);
    const { stream_id, message_id } = PostGmMessageResponse.parse(await res.json());

    const stream = await request(`/v1/gm/stream/${stream_id}`, { as: ALICE });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("Content-Type")).toMatch(/^text\/event-stream/);
    const raw = await stream.text();
    expect(raw).toMatch(/^event: text\ndata: \{"delta":"/);
    const { events } = parseSse(raw);
    const names = events
      .map((e) => e.event)
      .filter((n, i, all) => n !== "text" || all[i - 1] !== "text");
    expect(names).toEqual(["text", "progress", "component", "text", "done"]);
    expect(events.find((e) => e.event === "progress")?.data).toEqual({
      label: "Checking your Shelf",
    });
    expect(events.find((e) => e.event === "component")?.data).toMatchObject({
      kind: "item_cards",
      data: { items: [{ id: ALICE_ITEM, value: { low_cents: 9000, high_cents: 13000 } }] },
    });
    const done = events.at(-1)?.data as { message_id: string };

    // History has the same message IDs and rebuilds the card from the stored tool call.
    const convo = GmConversation.parse(
      await (await request("/v1/gm/conversation", { as: ALICE })).json(),
    );
    expect(convo.mode).toBe("intake");
    expect(convo.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(convo.messages[1]?.id).toBe(message_id);
    expect(convo.messages[2]).toMatchObject({
      id: done.message_id,
      text: "Let me check.\n\nThat's your Falcon.",
      components: [{ kind: "item_cards", data: { items: [{ id: ALICE_ITEM }] } }],
    });

    // A finished stream can be read again until it expires.
    const again = parseSse(
      await (await request(`/v1/gm/stream/${stream_id}`, { as: ALICE })).text(),
    );
    expect(again.events.at(-1)?.event).toBe("done");
  });

  it("allows 1 running turn per user and sends keep-alive comments while it runs", async () => {
    const { request, model } = await setup([{ text: "Hi!" }, { text: "Hi again!" }], {
      gated: true,
      keepAliveMs: 5,
    });
    const first = await post(request, { text: "hello" });
    expect(first.status).toBe(202);
    const { stream_id } = PostGmMessageResponse.parse(await first.json());

    const busy = await post(request, { text: "hello?" });
    expect(busy.status).toBe(409);
    expect(await errorCode(busy)).toBe("turn_in_progress");
    // Another user is not blocked.
    expect((await post(request, { text: "hey" }, BOB)).status).toBe(202);

    const reading = request(`/v1/gm/stream/${stream_id}`, { as: ALICE }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    (model as GatedModel).open();
    const { events, comments } = parseSse(await reading);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]).toBe(": keep-alive");
    expect(events.at(-1)?.event).toBe("done");

    expect((await post(request, { text: "now?" })).status).toBe(202);
  });

  it("reports a failed turn as an error event and frees the user", async () => {
    const { request } = await setup([{ error: new Error("boom") }, { text: "Back." }]);
    const res = await post(request, { text: "hello" });
    const { stream_id } = PostGmMessageResponse.parse(await res.json());
    const { events } = parseSse(
      await (await request(`/v1/gm/stream/${stream_id}`, { as: ALICE })).text(),
    );
    expect(events).toEqual([
      { event: "error", data: { code: "gm_failed", message: expect.any(String) } },
    ]);
    expect((await post(request, { text: "again" })).status).toBe(202);
  });

  it("validates input without holding the turn slot", async () => {
    const { request } = await setup([{ text: "ok" }]);
    const empty = await post(request, {});
    expect(empty.status).toBe(400);
    expect(await errorCode(empty)).toBe("validation_error");

    const choice = await post(request, { choice: { component_id: "x", option_ids: ["y"] } });
    expect(choice.status).toBe(400);
    expect(await errorCode(choice)).toBe("unknown_component");

    const media = await post(request, { media_paths: [`${BOB}/items/x.jpg`] });
    expect(await errorCode(media)).toBe("invalid_media_path");

    expect((await post(request, { text: "fine" })).status).toBe(202);
  });

  it("keeps streams private to their user and 404s unknown ones", async () => {
    const { request } = await setup([{ text: "secret" }]);
    const { stream_id } = PostGmMessageResponse.parse(
      await (await post(request, { text: "hi" })).json(),
    );
    const bob = await request(`/v1/gm/stream/${stream_id}`, { as: BOB });
    expect(bob.status).toBe(404);
    expect(await errorCode(bob)).toBe("stream_not_found");
    expect((await request("/v1/gm/stream/nope", { as: ALICE })).status).toBe(404);
    expect((await request(`/v1/gm/stream/${stream_id}`)).status).toBe(401);
  });

  it("replays the same stream for a retried POST with the same Idempotency-Key", async () => {
    const { request, data } = await setup([{ text: "once" }]);
    const headers = { "Idempotency-Key": "gm-message-0001" };
    const a = await post(request, { text: "hi" }, ALICE, headers);
    const b = await post(request, { text: "hi" }, ALICE, headers);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    expect(data.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("answers 503 when the GM is not configured", async () => {
    const h = makeHarness();
    const res = await h.request("/v1/gm/conversation", { as: ALICE });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("gm_unavailable");
  });
});

describe("GmStreamHub", () => {
  it("expires finished streams after the TTL", () => {
    let now = 0;
    const hub = new GmStreamHub(() => now, 1000);
    const s = hub.tryStart(ALICE);
    if (!s) throw new Error("expected a stream");
    expect(hub.tryStart(ALICE)).toBeNull();
    hub.push(s, { event: "done", data: { message_id: ALICE } });
    hub.finish(s);
    now = 999;
    expect(hub.get(s.id)).toBe(s);
    now = 1001;
    expect(hub.get(s.id)).toBeNull();
  });

  it("ends a stream that finished without done or error", () => {
    const hub = new GmStreamHub();
    const s = hub.tryStart(ALICE);
    if (!s) throw new Error("expected a stream");
    hub.finish(s);
    expect(s.events.at(-1)?.event).toBe("error");
    expect(hub.isRunning(ALICE)).toBe(false);
  });
});
