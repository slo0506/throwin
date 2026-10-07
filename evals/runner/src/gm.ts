import { fileURLToPath } from "node:url";
import {
  dollarAmounts,
  GmService,
  loadGmPrompts,
  MemoryGmData,
  type ModelClient,
  ResolvedTargetData,
  type ResolverRun,
  type StoredMessage,
  type TargetResolver,
} from "@throwin/harness";
import {
  AskCardTarget,
  AskStatus,
  AutonomyLevel,
  ConditionGrade,
  GmComponentKind,
  GmMode,
  type GmStreamEvent,
  ItemReadiness,
  ItemStatus,
  ItemWillingness,
} from "@throwin/shared";
import { z } from "zod";
import type { SnapshotCase } from "./cases.js";

/** Suites the GM runner grades. */
export const GM_SUITES = ["grounding", "intake", "ask_resolution", "safety"] as const;

const cents = z.number().int().nonnegative();
const Value = z.strictObject({ low: cents, mid: cents, high: cents });

const ShelfEntry = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  category: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  condition_grade: ConditionGrade.optional(),
  value_cents: Value.optional(),
  willingness: ItemWillingness.optional(),
  status: ItemStatus.optional(),
  readiness: ItemReadiness.optional(),
  description: z.string().optional(),
});

const CircleMember = z.strictObject({
  user_id: z.uuid(),
  first_name: z.string(),
  items: z.array(
    z.strictObject({
      id: z.uuid(),
      title: z.string(),
      category: z.string().optional(),
      condition_grade: ConditionGrade.optional(),
      value_cents: Value.optional(),
      readiness: ItemReadiness.optional(),
      description: z.string().optional(),
    }),
  ),
});

const AskEntry = z.strictObject({
  id: z.uuid(),
  raw_text: z.string(),
  title: z.string().optional(),
  status: AskStatus,
  target: AskCardTarget.optional(),
  offer_item_ids: z.array(z.uuid()).default([]),
  cash_ceiling_cents: cents.default(0),
});

/** `state` of a GM snapshot case: the database the turn starts from. */
export const GmCaseState = z.strictObject({
  user: z.strictObject({ first_name: z.string(), autonomy: AutonomyLevel.optional() }),
  mode: GmMode.default("chat"),
  shelf: z.array(ShelfEntry).default([]),
  circle: z.array(CircleMember).default([]),
  asks: z.array(AskEntry).default([]),
  facts: z
    .array(z.strictObject({ key: z.string(), value: z.string(), category: z.string() }))
    .default([]),
  /** A canned resolve_target result, so a case does not depend on live web prices. */
  resolver_target: ResolvedTargetData.optional(),
});
export type GmCaseState = z.infer<typeof GmCaseState>;

/** `expect` of a GM snapshot case. Strict, so a misspelled check fails loudly. */
export const GmExpect = z.strictObject({
  tools_called: z.array(z.string()).optional(),
  tools_not_called: z.array(z.string()).optional(),
  /** No write tool succeeded. */
  no_successful_writes: z.boolean().optional(),
  components: z.array(GmComponentKind).optional(),
  components_absent: z.array(GmComponentKind).optional(),
  /** Case-insensitive phrases the GM's text must not contain. */
  text_excludes: z.array(z.string()).optional(),
  /** At least 1 of these phrases appears (case-insensitive). */
  text_includes_any: z.array(z.string()).optional(),
  /** Every dollar amount in the GM's text appeared in a tool result, the session or the user's words. */
  prices_grounded: z.boolean().optional(),
  /** This ID never appears in a successful tool call's input. */
  unseen_id_unused: z.string().optional(),
  asks_min: z.number().int().optional(),
  asks_max: z.number().int().optional(),
  ask_title_includes: z.string().optional(),
  mode: GmMode.optional(),
  /** At most this many present_choices calls (clarifying questions). */
  max_choice_questions: z.number().int().optional(),
  /** The first Ask's offer set, exactly. */
  offer_items: z.array(z.uuid()).optional(),
  /** The user's profile setting afterwards: which deals to bring them. */
  autonomy: AutonomyLevel.optional(),
});
export type GmExpect = z.infer<typeof GmExpect>;

export const isGmCase = (c: SnapshotCase) => (GM_SUITES as readonly string[]).includes(c.suite);

export const EVAL_USER = "eeeeeeee-0000-4000-8000-000000000001";
const PROMPT_DIR = fileURLToPath(new URL("../../../agents/gm", import.meta.url));

class CannedResolver implements TargetResolver {
  constructor(private readonly target: ResolvedTargetData) {}
  async resolve(_input: unknown, _onRun: (run: ResolverRun) => Promise<void>) {
    return this.target;
  }
}

function seed(state: GmCaseState, data: MemoryGmData) {
  data.addUser(EVAL_USER, {
    firstName: state.user.first_name,
    autonomy: state.user.autonomy ?? "every_deal",
  });
  for (const s of state.shelf) {
    data.addItem({
      id: s.id,
      ownerId: EVAL_USER,
      title: s.title,
      category: s.category ?? null,
      brand: s.brand ?? null,
      model: s.model ?? null,
      conditionGrade: s.condition_grade ?? null,
      valueLowCents: s.value_cents?.low ?? null,
      valueMidCents: s.value_cents?.mid ?? null,
      valueHighCents: s.value_cents?.high ?? null,
      willingness: s.willingness ?? "would_trade",
      status: s.status ?? "on_shelf",
      readiness: s.readiness ?? "identified",
      description: s.description ?? null,
    });
  }
  if (state.circle.length) data.joinCircle(EVAL_USER, "eval-circle");
  for (const m of state.circle) {
    data.addUser(m.user_id, { firstName: m.first_name });
    data.joinCircle(m.user_id, "eval-circle");
    for (const i of m.items) {
      data.addNetworkItem({
        id: i.id,
        ownerId: m.user_id,
        ownerFirstName: m.first_name,
        title: i.title,
        category: i.category ?? null,
        conditionGrade: i.condition_grade ?? null,
        valueLowCents: i.value_cents?.low ?? null,
        valueMidCents: i.value_cents?.mid ?? null,
        valueHighCents: i.value_cents?.high ?? null,
        readiness: i.readiness ?? "showcase",
        description: i.description ?? null,
      });
    }
  }
  for (const a of state.asks) {
    const at = data.now();
    data.asks.push({
      id: a.id,
      userId: EVAL_USER,
      rawText: a.raw_text,
      title: a.title ?? a.target?.name ?? null,
      status: a.status,
      target: a.target ?? null,
      cashCeilingCents: a.cash_ceiling_cents,
      deadline: null,
      autonomy: state.user.autonomy ?? "every_deal",
      offerItemIds: a.offer_item_ids,
      createdAt: at,
      updatedAt: at,
    });
  }
  data.facts.set(
    EVAL_USER,
    state.facts.map((f, i) => ({ id: `fact-${i}`, ...f })),
  );
}

async function seedConversation(
  c: SnapshotCase,
  state: GmCaseState,
  data: MemoryGmData,
): Promise<void> {
  const convo = await data.createConversation(EVAL_USER);
  let clock = data.now().getTime() - 60_000;
  const row = (
    role: StoredMessage["role"],
    content: StoredMessage["content"],
    toolCalls: unknown,
  ): StoredMessage => ({
    id: crypto.randomUUID(),
    conversationId: convo.id,
    userId: EVAL_USER,
    role,
    content,
    toolCalls,
    createdAt: new Date(clock++),
  });
  const rows: StoredMessage[] = [];
  if (state.mode === "chat") {
    // An intake that already finished, as the harness would have stored it.
    rows.push(
      row("assistant", [{ type: "tool_use", id: "toolu_seed", name: "finish_intake", input: {} }], {
        kind: "tool_calls",
        calls: [{ tool_use_id: "toolu_seed", name: "finish_intake", input: {}, ok: true }],
      }),
      row(
        "user",
        [{ type: "tool_result", tool_use_id: "toolu_seed", content: "Intake finished." }],
        {
          kind: "tool_results",
        },
      ),
    );
  }
  for (const turn of c.conversation) {
    rows.push(
      turn.role === "user"
        ? row("user", [{ type: "text", text: turn.content }], {
            kind: "user_input",
            display_text: turn.content,
          })
        : row("assistant", [{ type: "text", text: turn.content }], null),
    );
  }
  await data.appendMessages(rows);
}

export interface GmCaseResult {
  id: string;
  pass: boolean;
  failures: string[];
  text: string;
  tools: { name: string; ok: boolean }[];
  costCents: number;
  error: string | null;
}

const WRITE_TOOLS = new Set([
  "upsert_ask",
  "set_offer_set",
  "set_autonomy",
  "update_item",
  "finish_intake",
]);

/** Runs 1 GM snapshot case through the real harness on an in-memory database. */
export async function runGmCase(c: SnapshotCase, model: ModelClient): Promise<GmCaseResult> {
  const state = GmCaseState.parse(c.state);
  const expect = GmExpect.parse(c.expect);
  const data = new MemoryGmData();
  seed(state, data);
  await seedConversation(c, state, data);
  // Everything the GM was shown sits in user-role content: the session block, the user's
  // words and tool results. Its own earlier text does not count as a source.
  const shownParts: string[] = [];
  const recording: ModelClient = {
    stream: (params, onText) => {
      for (const m of params.messages)
        if (m.role === "user") shownParts.push(JSON.stringify(m.content));
      return model.stream(params, onText);
    },
    create: (params) => model.create(params),
  };
  const gm = new GmService({
    data,
    model: recording,
    prompts: await loadGmPrompts(PROMPT_DIR),
    ...(state.resolver_target && { resolver: new CannedResolver(state.resolver_target) }),
  });

  const events: GmStreamEvent[] = [];
  const prepared = await gm.prepareTurn(EVAL_USER, { text: c.message });
  await prepared.run((e) => events.push(e));

  const text = events.flatMap((e) => (e.event === "text" ? [e.data.delta] : [])).join("");
  const components = events.flatMap((e) => (e.event === "component" ? [e.data.kind] : []));
  const calls = data.events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({
      name: String(e.payload.tool),
      ok: e.payload.ok === true,
      input: e.payload.input,
    }));
  const errorEvent = events.find((e) => e.event === "error");
  const mode = (await gm.getConversation(EVAL_USER)).mode;

  // Tool results of the final step never reach another request, so add the stored ones.
  const shown = [
    ...shownParts,
    ...data.messages.flatMap((m) =>
      m.role === "user" ? m.content.map((b) => JSON.stringify(b)) : [],
    ),
  ].join("\n");

  const failures: string[] = [];
  const lower = text.toLowerCase();
  const called = new Set(calls.map((t) => t.name));
  for (const name of expect.tools_called ?? []) {
    if (!called.has(name)) failures.push(`expected a ${name} call`);
  }
  for (const name of expect.tools_not_called ?? []) {
    if (called.has(name)) failures.push(`expected no ${name} call`);
  }
  if (expect.no_successful_writes) {
    const writes = calls.filter((t) => t.ok && WRITE_TOOLS.has(t.name));
    if (writes.length)
      failures.push(`expected no writes, got ${writes.map((w) => w.name).join(", ")}`);
  }
  for (const kind of expect.components ?? []) {
    if (!components.includes(kind)) failures.push(`expected a ${kind} card`);
  }
  for (const kind of expect.components_absent ?? []) {
    if (components.includes(kind)) failures.push(`expected no ${kind} card`);
  }
  for (const phrase of expect.text_excludes ?? []) {
    if (lower.includes(phrase.toLowerCase())) failures.push(`text contains "${phrase}"`);
  }
  if (
    expect.text_includes_any &&
    !expect.text_includes_any.some((p) => lower.includes(p.toLowerCase()))
  ) {
    failures.push(`text has none of: ${expect.text_includes_any.join(", ")}`);
  }
  if (expect.prices_grounded) {
    const known = new Set(dollarAmounts(shown));
    const invented = dollarAmounts(text).filter((a) => !known.has(a));
    if (invented.length)
      failures.push(`ungrounded amounts in text: ${invented.map((a) => `$${a}`).join(", ")}`);
  }
  if (expect.unseen_id_unused) {
    const id = expect.unseen_id_unused;
    const used = calls.filter((t) => t.ok && JSON.stringify(t.input).includes(id));
    if (used.length) failures.push(`${id} was used by ${used.map((u) => u.name).join(", ")}`);
  }
  const asks = data.asks.filter((a) => a.userId === EVAL_USER);
  if (expect.asks_min !== undefined && asks.length < expect.asks_min) {
    failures.push(`expected at least ${expect.asks_min} Asks, got ${asks.length}`);
  }
  if (expect.asks_max !== undefined && asks.length > expect.asks_max) {
    failures.push(`expected at most ${expect.asks_max} Asks, got ${asks.length}`);
  }
  if (expect.ask_title_includes) {
    const want = expect.ask_title_includes.toLowerCase();
    if (!asks.some((a) => (a.title ?? a.target?.name ?? "").toLowerCase().includes(want))) {
      failures.push(`no Ask titled with "${expect.ask_title_includes}"`);
    }
  }
  if (expect.mode && mode !== expect.mode)
    failures.push(`expected mode ${expect.mode}, got ${mode}`);
  if (expect.max_choice_questions !== undefined) {
    const n = calls.filter((t) => t.name === "present_choices" && t.ok).length;
    if (n > expect.max_choice_questions) failures.push(`asked ${n} choice questions`);
  }
  if (expect.offer_items) {
    const got = [...(asks[0]?.offerItemIds ?? [])].sort();
    const want = [...expect.offer_items].sort();
    if (JSON.stringify(got) !== JSON.stringify(want))
      failures.push(`offer set is [${got.join(", ")}]`);
  }
  if (expect.autonomy) {
    const level = (await data.getUser(EVAL_USER))?.autonomy;
    if (level !== expect.autonomy) failures.push(`autonomy is ${level}`);
  }
  if (errorEvent) failures.push(`turn failed: ${JSON.stringify(errorEvent.data)}`);

  return {
    id: c.id,
    pass: failures.length === 0,
    failures,
    text,
    tools: calls.map(({ name, ok }) => ({ name, ok })),
    costCents: data.runs.reduce((s, r) => s + r.costCents, 0),
    error: errorEvent ? JSON.stringify(errorEvent.data) : null,
  };
}
