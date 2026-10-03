import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { GmStreamEvent, PostGmMessage } from "@throwin/shared";
import type { ResolvedTargetData } from "../src/history.js";
import { MemoryGmData } from "../src/memory-data.js";
import { type GmPrompts, loadGmPrompts } from "../src/prompts.js";
import type { ResolveInput, ResolverRun, TargetResolver } from "../src/resolver.js";
import { GmService } from "../src/service.js";
import { FakeModelClient, type FakeStep } from "../src/testing.js";

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const ALICE_LEGO = "aaaaaaaa-0000-4000-8000-000000000001";
export const ALICE_ZELDA = "aaaaaaaa-0000-4000-8000-000000000002";
export const BOB_ITEM = "bbbbbbbb-0000-4000-8000-000000000001";
export const NOW = new Date("2026-10-03T12:00:00.000Z");

const PROMPT_DIR = fileURLToPath(new URL("../../../agents/gm", import.meta.url));
let prompts: Promise<GmPrompts> | null = null;
export const testPrompts = () => {
  prompts ??= loadGmPrompts(PROMPT_DIR);
  return prompts;
};

export const BATMOBILE: ResolvedTargetData = {
  kind: "exact",
  name: "LEGO Batman Batmobile Tumbler 76240",
  brand: "LEGO",
  model: "76240",
  category: "toys/lego",
  constraints: [],
  anchor: { retail_cents: 26999, used_low_cents: 18000, used_high_cents: 25000 },
  confidence: 0.9,
  alternatives: [],
};

export class FakeResolver implements TargetResolver {
  readonly calls: ResolveInput[] = [];
  constructor(public target: ResolvedTargetData = BATMOBILE) {}

  async resolve(input: ResolveInput, onRun: (run: ResolverRun) => Promise<void>) {
    this.calls.push(input);
    await onRun({
      model: "claude-sonnet-5-5",
      usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
      searches: 1,
      costCents: 1.3,
      latencyMs: 10,
      outcome: "ok",
    });
    return this.target;
  }
}

export interface World {
  data: MemoryGmData;
  model: FakeModelClient;
  resolver: FakeResolver;
  gm: GmService;
}

export async function makeWorld(steps: FakeStep[] = []): Promise<World> {
  const data = new MemoryGmData();
  data.now = () => NOW;
  data.addUser(ALICE, { firstName: "Alice" });
  data.addUser(BOB, { firstName: "Bob" });
  data.addItem({
    id: ALICE_LEGO,
    ownerId: ALICE,
    title: "LEGO Millennium Falcon 75257",
    valueLowCents: 9000,
    valueMidCents: 11000,
    valueHighCents: 13000,
    conditionGrade: "B",
    thumbnailPath: `${ALICE}/items/${ALICE_LEGO}/1.jpg`,
  });
  data.addItem({
    id: ALICE_ZELDA,
    ownerId: ALICE,
    title: "Zelda: Tears of the Kingdom (Switch)",
    valueLowCents: 3500,
    valueMidCents: 4000,
    valueHighCents: 4500,
    conditionGrade: "A",
  });
  data.joinCircle(ALICE, "circle-1");
  data.joinCircle(BOB, "circle-1");
  const model = new FakeModelClient(steps);
  const resolver = new FakeResolver();
  let seq = 0;
  const gm = new GmService({
    data,
    model,
    prompts: await testPrompts(),
    resolver,
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  });
  return { data, model, resolver, gm };
}

/** Runs 1 turn and collects every stream event. */
export async function turn(world: World, body: PostGmMessage, userId = ALICE) {
  const prepared = await world.gm.prepareTurn(userId, body);
  const events: GmStreamEvent[] = [];
  await prepared.run((e) => events.push(e));
  return { prepared, events };
}

/** The tool results the model saw in its latest request, as text. */
export function lastToolResults(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Anthropic.ToolResultBlockParam[] {
  const last = params.messages.at(-1);
  if (!last || typeof last.content === "string") return [];
  return last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}

export const resultText = (r: Anthropic.ToolResultBlockParam) =>
  typeof r.content === "string"
    ? r.content
    : (r.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");

/** The text of the request's session block (the first block of the first message). */
export function sessionBlockOf(params: Anthropic.MessageCreateParamsNonStreaming | undefined) {
  const content = params?.messages[0]?.content;
  if (!Array.isArray(content)) return "";
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

/** Pulls the first `key: <uuid>` out of the latest tool result. */
export function idFromLastResult(params: Anthropic.MessageCreateParamsNonStreaming, key: string) {
  const text = lastToolResults(params).map(resultText).join("\n");
  const match = text.match(new RegExp(`${key}: ([0-9a-f-]{36})`));
  if (!match?.[1]) throw new Error(`No ${key} in: ${text}`);
  return match[1];
}
