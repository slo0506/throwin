import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ChoicesData,
  fenceUntrusted,
  GmComponent,
  type GmConversation,
  type GmMessage,
  type GmStreamEvent,
  type PostGmMessage,
} from "@throwin/shared";
import { buildSessionBlock, volatileBlock } from "./context.js";
import type { Conversation, GmData, GmUser, StoredMessage } from "./data.js";
import { clean } from "./format.js";
import {
  choicesMade,
  groupForClient,
  type RowMeta,
  type ToolCallRecord,
  toApiMessages,
  toolCallsOf,
  trimToTurnStart,
  type UserInputRecord,
} from "./history.js";
import { type ModelCallRecord, runTurn, type TurnStep } from "./loop.js";
import { addUsage, costCents, emptyUsage, GM_MODELS, type ModelClient } from "./model.js";
import { type GmPrompts, greetingFor } from "./prompts.js";
import { ClaudeTargetResolver, type ResolverRun, type TargetResolver } from "./resolver.js";
import { GmSession } from "./session.js";
import { createToolRegistry } from "./tools/index.js";
import type { ToolContext, ToolEvent, ToolRegistry } from "./tools/registry.js";
import { renderAskCard, renderItemCards } from "./tools/render.js";

export interface GmLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const quietLogger: GmLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface GmServiceDeps {
  data: GmData;
  model: ModelClient;
  prompts: GmPrompts;
  resolver?: TargetResolver;
  logger?: GmLogger;
  now?: () => Date;
  newId?: () => string;
  modelName?: string;
  maxTokens?: number;
  maxSteps?: number;
  /** Stored rows the model sees: the newest N, trimmed to a turn start. */
  historyLimit?: number;
}

/** A bad request the client can fix. `message` is safe to show. */
export class GmInputError extends Error {
  constructor(
    readonly status: 400 | 404 | 410,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GmInputError";
  }
}

export interface PreparedTurn {
  conversationId: string;
  /** The stored user message. */
  messageId: string;
  /** Runs the turn, emitting stream events, and never throws. */
  run(emit: (event: GmStreamEvent) => void): Promise<void>;
}

export const GM_FAILED_MESSAGE = "Something went wrong on my side. Try that again in a moment.";
const EMPTY_REPLY = "Sorry, I lost my train of thought there. Could you say that again?";
const CLIENT_HISTORY_LIMIT = 200;

/**
 * The GM, wired to its data, model and prompts. Stateless between turns: every turn
 * rebuilds its session (allow-list, targets, cards) from stored messages.
 */
export class GmService {
  readonly registry: ToolRegistry;
  readonly #data: GmData;
  readonly #model: ModelClient;
  readonly #prompts: GmPrompts;
  readonly #resolver: TargetResolver;
  readonly #logger: GmLogger;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #modelName: string;
  readonly #maxTokens: number;
  readonly #maxSteps: number;
  readonly #historyLimit: number;

  constructor(deps: GmServiceDeps) {
    this.#data = deps.data;
    this.#model = deps.model;
    this.#prompts = deps.prompts;
    this.#resolver = deps.resolver ?? new ClaudeTargetResolver(deps.model);
    this.#logger = deps.logger ?? quietLogger;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomUUID;
    this.#modelName = deps.modelName ?? GM_MODELS.gm;
    this.#maxTokens = deps.maxTokens ?? 1500;
    this.#maxSteps = deps.maxSteps ?? 8;
    this.#historyLimit = deps.historyLimit ?? 80;
    this.registry = createToolRegistry(deps.prompts);
  }

  get promptVersion() {
    return this.#prompts.version;
  }

  async #user(userId: string): Promise<GmUser> {
    const user = await this.#data.getUser(userId);
    if (!user) throw new GmInputError(404, "user_not_found", "No account for this session");
    return user;
  }

  /** The user's current conversation, created (with the intake greeting) on first call. */
  async #conversation(user: GmUser): Promise<Conversation> {
    const existing = await this.#data.latestConversation(user.id);
    if (existing) return existing;
    const conversation = await this.#data.createConversation(user.id);
    await this.#data.appendMessages([
      {
        id: this.#newId(),
        conversationId: conversation.id,
        userId: user.id,
        role: "assistant",
        content: [
          {
            type: "text",
            text: greetingFor(this.#prompts, user.firstName ? clean(user.firstName, 40) : null),
          },
        ],
        toolCalls: { kind: "greeting" } satisfies RowMeta,
        createdAt: this.#now(),
      },
    ]);
    return conversation;
  }

  async getConversation(userId: string): Promise<GmConversation> {
    const user = await this.#user(userId);
    const conversation = await this.#conversation(user);
    const [rows, finished] = await Promise.all([
      this.#data.listMessages(userId, conversation.id, CLIENT_HISTORY_LIMIT),
      this.#data.intakeFinished(userId, conversation.id),
    ]);
    const picks = choicesMade(rows);
    const messages: GmMessage[] = [];
    for (const group of groupForClient(rows)) {
      const components: GmComponent[] = [];
      for (const call of group.calls) {
        const component = await this.#rebuild(userId, call, picks);
        if (component) components.push(component);
      }
      messages.push({
        id: group.id,
        role: group.role,
        text: group.text,
        components,
        created_at: group.createdAt.toISOString(),
      });
    }
    return {
      conversation_id: conversation.id,
      mode: finished ? "chat" : "intake",
      messages,
    };
  }

  /** Re-renders a stored card: Items and Asks with fresh data, the rest as rendered. */
  async #rebuild(
    userId: string,
    call: ToolCallRecord,
    picks: Map<string, string[]>,
  ): Promise<GmComponent | null> {
    const c = call.component;
    if (!call.ok || !c) return null;
    const scope = { userId, data: this.#data };
    try {
      if (c.kind === "item_cards") {
        const input = call.input as { item_ids?: string[]; selectable?: boolean };
        const { data } = await renderItemCards(
          scope,
          input.item_ids ?? [],
          input.selectable ?? false,
          picks.get(c.id) ?? [],
        );
        return { id: c.id, kind: "item_cards", data };
      }
      if (c.kind === "ask_card") {
        const data = await renderAskCard(scope, (call.input as { ask_id: string }).ask_id);
        return data ? { id: c.id, kind: "ask_card", data } : null;
      }
      const parsed = GmComponent.safeParse({ id: c.id, kind: c.kind, data: c.data });
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.#logger.warn("gm_rebuild_failed", { component_id: c.id, error: String(err) });
      return null;
    }
  }

  /**
   * Validates and stores the user's message, and returns the turn to run. Throws
   * GmInputError for anything the client should fix.
   */
  async prepareTurn(userId: string, body: PostGmMessage): Promise<PreparedTurn> {
    const user = await this.#user(userId);
    const conversation = await this.#conversation(user);
    const rows = trimToTurnStart(
      await this.#data.listMessages(userId, conversation.id, this.#historyLimit),
    );
    const finished = await this.#data.intakeFinished(userId, conversation.id);
    const session = new GmSession(userId, conversation.id, finished ? "chat" : "intake");
    session.absorb(rows);

    const { content, meta } = await this.#userContent(session, rows, body);
    const messageId = this.#newId();
    // Strictly increasing timestamps keep rows of 1 turn in order, even within 1 millisecond.
    let clock = (rows.at(-1)?.createdAt.getTime() ?? 0) + 1;
    const tick = () => {
      clock = Math.max(clock, this.#now().getTime());
      return new Date(clock++);
    };
    await this.#data.appendMessages([
      {
        id: messageId,
        conversationId: conversation.id,
        userId,
        role: "user",
        content,
        toolCalls: meta,
        createdAt: tick(),
      },
    ]);

    return {
      conversationId: conversation.id,
      messageId,
      run: (emit) =>
        this.#run({ user, session, rows, content, messageId, screen: body.screen, emit, tick }),
    };
  }

  async #userContent(
    session: GmSession,
    rows: StoredMessage[],
    body: PostGmMessage,
  ): Promise<{ content: Anthropic.ContentBlockParam[]; meta: UserInputRecord }> {
    const content: Anthropic.ContentBlockParam[] = [];
    const display: string[] = [];
    if (body.text) {
      content.push({ type: "text", text: body.text });
      display.push(body.text);
    }

    if (body.choice) {
      const { component_id: componentId, option_ids: optionIds } = body.choice;
      const known = session.components.get(componentId);
      if (!known || (known.kind !== "choices" && known.kind !== "item_cards")) {
        throw new GmInputError(
          400,
          "unknown_component",
          "That card isn't part of this conversation",
        );
      }
      const allowed = new Set(known.optionIds);
      if (optionIds.some((id) => !allowed.has(id))) {
        throw new GmInputError(400, "invalid_choice", "That option isn't on this card");
      }
      const picked = await this.#describeChoice(session, rows, componentId, known.kind, optionIds);
      content.push({ type: "text", text: picked.forModel });
      if (!body.text) display.push(picked.forUser);
    }

    if (body.media_paths) {
      const prefix = `${session.userId}/`;
      if (body.media_paths.some((p) => !p.startsWith(prefix) || p.includes(".."))) {
        throw new GmInputError(400, "invalid_media_path", "Photos must come from your own uploads");
      }
      session.allow.remember(body.media_paths);
      const n = body.media_paths.length;
      content.push({
        type: "text",
        text: `[The user attached ${n} photo${n === 1 ? "" : "s"}: ${body.media_paths.join(", ")}. To identify what they want from a photo, call resolve_target with image_path.]`,
      });
      if (display.length === 0) display.push(`Sent ${n} photo${n === 1 ? "" : "s"}`);
    }

    return {
      content,
      meta: {
        kind: "user_input",
        display_text: display.join("\n"),
        ...(body.choice && { choice: body.choice }),
        ...(body.media_paths && { media_paths: body.media_paths }),
      },
    };
  }

  async #describeChoice(
    session: GmSession,
    rows: StoredMessage[],
    componentId: string,
    kind: "choices" | "item_cards",
    optionIds: string[],
  ) {
    if (kind === "choices") {
      const call = rows.flatMap(toolCallsOf).find((c) => c.component?.id === componentId);
      const data = ChoicesData.safeParse(call?.component?.data);
      const labels = new Map(data.success ? data.data.options.map((o) => [o.id, o.label]) : []);
      const picked = optionIds.map((id) => ({ id, label: labels.get(id) ?? id }));
      return {
        forModel: `[The user tapped on card ${componentId}${data.success ? ` ("${data.data.prompt}")` : ""}: ${picked.map((p) => `${p.label} (option ${p.id})`).join("; ")}]`,
        forUser: picked.map((p) => p.label).join(", "),
      };
    }
    const own = await this.#data.getOwnItems(session.userId, optionIds);
    const ownIds = new Set(own.map((i) => i.id));
    const rest = optionIds.filter((id) => !ownIds.has(id));
    const others = rest.length
      ? await this.#data.listNetworkItems(session.userId, { ids: rest, limit: rest.length })
      : [];
    const lines = [
      ...own.map((i) => `- ${i.id}: ${clean(i.title, 120)} (their own)`),
      ...others.map(
        (i) => `- ${i.id}:\n${fenceUntrusted("item_title", i.title, { maxLength: 120 })}`,
      ),
    ];
    return {
      forModel: `[The user picked ${optionIds.length} Item${optionIds.length === 1 ? "" : "s"} on card ${componentId}:\n${lines.join("\n")}]`,
      forUser: [
        ...own.map((i) => clean(i.title, 80)),
        ...others.map((i) => clean(i.title, 80)),
      ].join(", "),
    };
  }

  async #run(t: {
    user: GmUser;
    session: GmSession;
    rows: StoredMessage[];
    content: Anthropic.ContentBlockParam[];
    messageId: string;
    screen: string | undefined;
    emit: (event: GmStreamEvent) => void;
    tick: () => Date;
  }): Promise<void> {
    const { session, emit } = t;
    const userId = session.userId;
    const fail = () =>
      emit({ event: "error", data: { code: "gm_failed", message: GM_FAILED_MESSAGE } });
    try {
      const ctx: ToolContext = {
        userId,
        session,
        data: this.#data,
        resolver: this.#resolver,
        prompts: this.#prompts,
        now: this.#now,
        newId: this.#newId,
        recordModelRun: (trigger, run) => this.#recordResolverRun(userId, trigger, run),
      };
      const sessionBlock = await buildSessionBlock(this.#data, session, t.user, this.#prompts);
      const result = await runTurn(
        {
          model: this.#model,
          modelName: this.#modelName,
          maxTokens: this.#maxTokens,
          maxSteps: this.#maxSteps,
          registry: this.registry,
          system: this.#prompts.system,
          newId: this.#newId,
          recordCall: (call) => this.#recordCall(userId, call),
          recordEvents: (runId, events) => this.#recordEvents(userId, runId, events),
        },
        {
          ctx,
          sessionBlock,
          history: toApiMessages(t.rows),
          current: t.content,
          volatile: volatileBlock(this.#now(), t.screen),
          emit,
        },
      );

      if (result.error) {
        this.#logger.error("gm_turn_failed", { user_id: userId, error: String(result.error) });
      }
      const steps = result.steps.filter((s) => s.assistant.length > 0 || s.results !== null);
      // A turn that showed nothing still answers, so the user is never left hanging.
      const showed = steps.some(
        (s) => s.assistant.some((b) => b.type === "text") || s.calls.some((c) => c.component),
      );
      if (!result.error && !showed) {
        emit({ event: "text", data: { delta: EMPTY_REPLY } });
        steps.push({ assistant: [{ type: "text", text: EMPTY_REPLY }], calls: [], results: null });
      }
      const assistantIds = await this.#persist(session, steps, t.tick);
      if (result.error) return fail();

      const finalId = assistantIds.at(-1) as string;
      // Facts from the intake turns are labeled "Intake chat", including the turn that ends it.
      const intakeTurn =
        session.mode === "intake" ||
        steps.some((s) => s.calls.some((c) => c.name === "finish_intake"));
      await this.#enqueueMemory(
        userId,
        session.conversationId,
        [t.messageId, ...assistantIds],
        intakeTurn ? "intake" : "chat",
      );
      emit({ event: "done", data: { message_id: finalId } });
    } catch (err) {
      this.#logger.error("gm_turn_crashed", { user_id: userId, error: String(err) });
      fail();
    }
  }

  /** Writes this turn's assistant and tool-result rows in 1 statement. */
  async #persist(session: GmSession, steps: TurnStep[], tick: () => Date): Promise<string[]> {
    const rows: StoredMessage[] = [];
    const assistantIds: string[] = [];
    for (const step of steps) {
      const id = this.#newId();
      assistantIds.push(id);
      rows.push({
        id,
        conversationId: session.conversationId,
        userId: session.userId,
        role: "assistant",
        content: step.assistant,
        toolCalls: step.calls.length
          ? ({ kind: "tool_calls", calls: step.calls } satisfies RowMeta)
          : null,
        createdAt: tick(),
      });
      if (step.results) {
        rows.push({
          id: this.#newId(),
          conversationId: session.conversationId,
          userId: session.userId,
          role: "user",
          content: step.results,
          toolCalls: { kind: "tool_results" } satisfies RowMeta,
          createdAt: tick(),
        });
      }
    }
    if (rows.length) await this.#data.appendMessages(rows);
    return assistantIds;
  }

  async #enqueueMemory(
    userId: string,
    conversationId: string,
    messageIds: string[],
    mode: "intake" | "chat",
  ) {
    try {
      await this.#data.enqueueJob("extract_memory", {
        user_id: userId,
        conversation_id: conversationId,
        message_ids: messageIds,
        mode,
      });
    } catch (err) {
      this.#logger.error("gm_enqueue_memory_failed", { user_id: userId, error: String(err) });
    }
  }

  async #recordCall(userId: string, call: ModelCallRecord): Promise<boolean> {
    const usage = call.usage ? addUsage(emptyUsage(), call.usage) : emptyUsage();
    try {
      await this.#data.recordRun({
        id: call.runId,
        userId,
        askId: null,
        agent: "gm",
        trigger: "turn",
        model: call.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        costCents: costCents(call.model, usage),
        latencyMs: call.latencyMs,
        outcome: call.outcome,
      });
      return true;
    } catch (err) {
      this.#logger.error("gm_record_run_failed", { user_id: userId, error: String(err) });
      return false;
    }
  }

  async #recordResolverRun(userId: string, trigger: string, run: ResolverRun) {
    try {
      await this.#data.recordRun({
        id: this.#newId(),
        userId,
        askId: null,
        agent: "gm",
        trigger,
        model: run.model,
        inputTokens: run.usage.input,
        outputTokens: run.usage.output,
        cacheReadTokens: run.usage.cacheRead,
        cacheWriteTokens: run.usage.cacheWrite,
        costCents: run.costCents,
        latencyMs: run.latencyMs,
        outcome: run.outcome,
      });
    } catch (err) {
      this.#logger.error("gm_record_run_failed", { user_id: userId, error: String(err) });
    }
  }

  async #recordEvents(userId: string, runId: string, events: ToolEvent[]) {
    if (events.length === 0) return;
    try {
      await this.#data.recordEvents(
        events.map((e) => ({
          runId,
          userId,
          ...e,
          payload: { ...e.payload, prompt_version: this.#prompts.version },
        })),
      );
    } catch (err) {
      this.#logger.error("gm_record_events_failed", { user_id: userId, error: String(err) });
    }
    for (const e of events) {
      if (e.type === "allow_list_rejected") {
        // Possible injection: alert on these (PRD "Observability").
        this.#logger.warn("gm_allow_list_rejected", { user_id: userId, ...e.payload });
      }
    }
  }
}
