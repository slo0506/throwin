import type Anthropic from "@anthropic-ai/sdk";
import type { GmStreamEvent } from "@throwin/shared";
import { buildRequest } from "./context.js";
import type { ToolCallRecord } from "./history.js";
import type { CreateParams, ModelClient } from "./model.js";
import type { ToolContext, ToolEvent, ToolRegistry } from "./tools/registry.js";

export interface TurnStep {
  /** API-native assistant content: text and the tool calls that ran. */
  assistant: Anthropic.ContentBlockParam[];
  calls: ToolCallRecord[];
  /** Tool results for this step, or null when the step ended the turn. */
  results: Anthropic.ToolResultBlockParam[] | null;
}

export interface TurnResult {
  steps: TurnStep[];
  /** Set when a model call failed. Completed steps are still returned. */
  error: unknown;
}

export interface ModelCallRecord {
  runId: string;
  model: string;
  usage: Anthropic.Usage | null;
  latencyMs: number;
  outcome: string;
}

export interface LoopOptions {
  model: ModelClient;
  modelName: string;
  maxTokens: number;
  /** Model calls with tools allowed. 1 more call without tools may wrap up. */
  maxSteps: number;
  registry: ToolRegistry;
  system: string;
  newId: () => string;
  recordCall: (call: ModelCallRecord) => Promise<boolean>;
  recordEvents: (runId: string, events: ToolEvent[]) => Promise<void>;
}

export interface TurnInput {
  ctx: ToolContext;
  sessionBlock: string;
  history: Anthropic.MessageParam[];
  current: Anthropic.ContentBlockParam[];
  volatile: string;
  emit: (event: GmStreamEvent) => void;
}

/** Keeps text and tool_use blocks in their plain API shape, dropping empty text. */
function storable(
  content: Anthropic.ContentBlock[],
  keepToolUse: boolean,
): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text.trim()) out.push({ type: "text", text: b.text });
    if (b.type === "tool_use" && keepToolUse) {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
  }
  return out;
}

/**
 * 1 GM turn: stream a response, run its tool calls, feed the results back, and repeat
 * until the model ends the turn. Text streams as `text` events; each tool emits its
 * `progress` line before it runs and its `component` after.
 */
export async function runTurn(o: LoopOptions, input: TurnInput): Promise<TurnResult> {
  const steps: TurnStep[] = [];
  const apiSteps: Anthropic.MessageParam[] = [];
  let wroteText = false;

  for (let i = 0; i <= o.maxSteps; i++) {
    const wrapUp = i === o.maxSteps;
    const request: CreateParams = {
      ...buildRequest({
        model: o.modelName,
        maxTokens: o.maxTokens,
        system: o.system,
        tools: o.registry.definitions(),
        sessionBlock: input.sessionBlock,
        history: input.history,
        current: input.current,
        volatile: input.volatile,
        steps: apiSteps,
      }),
      ...(wrapUp && { tool_choice: { type: "none" as const } }),
    };

    const runId = o.newId();
    const started = Date.now();
    let startedText = false;
    let message: Anthropic.Message;
    try {
      message = await o.model.stream(request, (delta) => {
        if (!startedText && wroteText) input.emit({ event: "text", data: { delta: "\n\n" } });
        startedText = true;
        input.emit({ event: "text", data: { delta } });
      });
    } catch (error) {
      await o.recordCall({
        runId,
        model: o.modelName,
        usage: null,
        latencyMs: Date.now() - started,
        outcome: "error",
      });
      return { steps, error };
    }
    if (startedText) wroteText = true;
    const recorded = await o.recordCall({
      runId,
      model: o.modelName,
      usage: message.usage,
      latencyMs: Date.now() - started,
      outcome: message.stop_reason ?? "unknown",
    });

    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const runsTools = message.stop_reason === "tool_use" && uses.length > 0 && !wrapUp;
    if (!runsTools) {
      steps.push({ assistant: storable(message.content, false), calls: [], results: null });
      return { steps, error: null };
    }

    const calls: ToolCallRecord[] = [];
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const label = o.registry.progressFor(use);
      if (label) input.emit({ event: "progress", data: { label } });
      const done = await o.registry.execute(input.ctx, use);
      if (done.component) input.emit({ event: "component", data: done.component });
      calls.push(done.record);
      results.push(done.result);
      if (recorded) await o.recordEvents(runId, done.events);
    }
    const assistant = storable(message.content, true);
    steps.push({ assistant, calls, results });
    apiSteps.push({ role: "assistant", content: assistant }, { role: "user", content: results });
  }
  return { steps, error: null };
}
