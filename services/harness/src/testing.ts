import type Anthropic from "@anthropic-ai/sdk";
import type { CreateParams, ModelClient } from "./model.js";

/** 1 scripted model response: text first, then tool calls, like Claude orders them. */
export interface FakeReply {
  text?: string;
  tools?: { name: string; input: unknown; id?: string }[];
  stopReason?: Anthropic.StopReason;
  usage?: Partial<Anthropic.Usage>;
  /** Throw instead of replying. */
  error?: Error;
}

export type FakeStep = FakeReply | ((params: CreateParams) => FakeReply);

let toolSeq = 0;

export function fakeMessage(reply: FakeReply, model: string): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (reply.text) content.push({ type: "text", text: reply.text, citations: null });
  for (const t of reply.tools ?? []) {
    content.push({
      type: "tool_use",
      id: t.id ?? `toolu_fake_${++toolSeq}`,
      name: t.name,
      input: t.input,
      caller: { type: "direct" },
    } as Anthropic.ToolUseBlock);
  }
  return {
    id: `msg_fake_${++toolSeq}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reply.stopReason ?? (reply.tools?.length ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...reply.usage,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

/**
 * A scripted stand-in for the Messages API. `stream` emits each reply's text in small
 * deltas. Every request is kept (deep-copied) so tests can check cache ordering.
 */
export class FakeModelClient implements ModelClient {
  readonly requests: CreateParams[] = [];
  readonly #steps: FakeStep[];
  /** Used when the script runs out. */
  fallback: FakeReply | null = { text: "Done." };

  constructor(steps: FakeStep[] = []) {
    this.#steps = [...steps];
  }

  push(...steps: FakeStep[]) {
    this.#steps.push(...steps);
  }

  get remaining() {
    return this.#steps.length;
  }

  #next(params: CreateParams): FakeReply {
    this.requests.push(structuredClone(params));
    const step = this.#steps.shift();
    const reply = typeof step === "function" ? step(params) : (step ?? this.fallback);
    if (!reply) throw new Error("FakeModelClient: script exhausted");
    if (reply.error) throw reply.error;
    return reply;
  }

  async stream(params: CreateParams, onText: (delta: string) => void) {
    const reply = this.#next(params);
    const text = reply.text ?? "";
    for (let i = 0; i < text.length; i += 8) onText(text.slice(i, i + 8));
    return fakeMessage(reply, params.model);
  }

  async create(params: CreateParams) {
    return fakeMessage(this.#next(params), params.model);
  }
}
