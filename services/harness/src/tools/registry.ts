import type Anthropic from "@anthropic-ai/sdk";
import { type GmComponent, UnknownIdError } from "@throwin/shared";
import { z } from "zod";
import type { GmData } from "../data.js";
import { dollarAmounts } from "../format.js";
import type { ResolvedTargetData, ToolCallRecord } from "../history.js";
import type { GmPrompts } from "../prompts.js";
import type { ResolverRun, TargetResolver } from "../resolver.js";
import type { GmSession } from "../session.js";

export interface ToolContext {
  userId: string;
  session: GmSession;
  data: GmData;
  resolver: TargetResolver;
  prompts: GmPrompts;
  now: () => Date;
  newId: () => string;
  /** Records a model call a tool made (resolve_target) as an `agent_runs` row. */
  recordModelRun: (trigger: string, run: ResolverRun) => Promise<void>;
}

export interface ToolOutput {
  /** What the model reads. Text written by other users must already be fenced. */
  content: string;
  /** IDs this result showed the model; they join the allow-list. */
  issuedIds?: string[];
  component?: GmComponent;
  /** Choice option IDs, or the Item IDs of a selectable card. */
  optionIds?: string[];
  target?: { target_id: string; data: ResolvedTargetData };
  /** A plain line for the user's Activity log. Only write tools set it. */
  summary?: string;
  askId?: string;
}

export type ToolKind = "read" | "write" | "render" | "meta";

export interface GmTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  kind: ToolKind;
  /** A plain-words progress line for the stream, or null for none. */
  progress: ((input: z.output<S>) => string) | null;
  run(ctx: ToolContext, input: z.output<S>): Promise<ToolOutput>;
}

/** A failure the model should read and recover from. `message` is shown to the model. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export const defineTool = <S extends z.ZodType>(tool: GmTool<S>): GmTool<S> => tool;

/** Asserts that every ID was issued to this conversation, with a message the model can act on. */
export function assertIssued(ctx: ToolContext, ...ids: string[]) {
  for (const id of ids) ctx.session.allow.assert(id);
}

export interface ToolEvent {
  type: string;
  userVisible: boolean;
  summary: string | null;
  payload: Record<string, unknown>;
}

export interface ExecutedTool {
  record: ToolCallRecord;
  result: Anthropic.ToolResultBlockParam;
  component: GmComponent | null;
  events: ToolEvent[];
}

function jsonSchemaOf(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest as Anthropic.Tool.InputSchema;
}

const SAFE_ERROR = "That tool failed on our side. Try once more or carry on without it.";

export class ToolRegistry {
  readonly #tools = new Map<string, GmTool>();
  readonly #definitions: Anthropic.Tool[];

  constructor(tools: GmTool[]) {
    for (const t of tools) this.#tools.set(t.name, t);
    this.#definitions = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: jsonSchemaOf(t.input),
    }));
  }

  /** Tool definitions in a fixed order, identical for every user (the global cache block). */
  definitions(): Anthropic.Tool[] {
    return this.#definitions;
  }

  get(name: string): GmTool | undefined {
    return this.#tools.get(name);
  }

  progressFor(use: Anthropic.ToolUseBlock): string | null {
    const tool = this.#tools.get(use.name);
    if (!tool?.progress) return null;
    const parsed = tool.input.safeParse(use.input);
    return parsed.success ? tool.progress(parsed.data) : null;
  }

  async execute(ctx: ToolContext, use: Anthropic.ToolUseBlock): Promise<ExecutedTool> {
    const started = Date.now();
    const tool = this.#tools.get(use.name);
    const events: ToolEvent[] = [];
    let output: ToolOutput | null = null;
    let errorCode: string | undefined;
    let errorMessage = "";

    if (!tool) {
      errorCode = "unknown_tool";
      errorMessage = `There is no tool named ${use.name}.`;
    } else {
      const parsed = tool.input.safeParse(use.input);
      if (!parsed.success) {
        errorCode = "invalid_input";
        errorMessage = `Invalid input: ${parsed.error.issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ")}`;
      } else {
        try {
          output = await tool.run(ctx, parsed.data);
        } catch (err) {
          if (err instanceof UnknownIdError) {
            errorCode = "unknown_id";
            errorMessage = `The ID ${err.id} was never returned to you in this conversation, so it cannot be used. Only use IDs that came back from a tool result or the session summary.`;
            events.push({
              type: "allow_list_rejected",
              userVisible: false,
              summary: null,
              payload: { tool: use.name, id: err.id },
            });
          } else if (err instanceof ToolError) {
            errorCode = err.code;
            errorMessage = err.message;
          } else {
            errorCode = "internal";
            errorMessage = SAFE_ERROR;
            events.push({
              type: "tool_failed",
              userVisible: false,
              summary: null,
              payload: { tool: use.name, error: err instanceof Error ? err.message : String(err) },
            });
          }
        }
      }
    }

    const ok = output !== null;
    const component = output?.component ?? null;
    const record: ToolCallRecord = {
      tool_use_id: use.id,
      name: use.name,
      input: use.input,
      ok,
      ...(errorCode && { error_code: errorCode }),
      ...(output?.issuedIds?.length && { issued_ids: [...new Set(output.issuedIds)] }),
      ...(component && {
        component: {
          id: component.id,
          kind: component.kind,
          ...(output?.optionIds && { option_ids: output.optionIds }),
          // Cards the server cannot refetch keep their rendered data.
          ...(STATIC_KINDS.has(component.kind) && { data: component.data }),
        },
      }),
      ...(output?.target && { target: output.target }),
    };
    if (output) {
      const amounts = dollarAmounts(output.content);
      if (amounts.length) record.amounts = [...new Set(amounts)];
      if (output.issuedIds) ctx.session.allow.remember(output.issuedIds);
      if (output.target) {
        ctx.session.allow.remember(output.target.target_id);
        ctx.session.targets.set(output.target.target_id, output.target.data);
      }
      for (const a of record.amounts ?? []) ctx.session.amounts.add(a);
      if (component) {
        ctx.session.components.set(component.id, {
          kind: component.kind,
          optionIds: output.optionIds ?? [],
        });
      }
    }

    events.unshift({
      type: "tool_call",
      userVisible: ok && tool?.kind === "write" && Boolean(output?.summary),
      summary: ok ? (output?.summary ?? null) : null,
      payload: {
        tool: use.name,
        tool_use_id: use.id,
        input: use.input,
        ok,
        ...(errorCode && { error_code: errorCode }),
        ...(output?.askId && { ask_id: output.askId }),
        duration_ms: Date.now() - started,
      },
    });

    return {
      record,
      result: {
        type: "tool_result",
        tool_use_id: use.id,
        content: ok ? (output as ToolOutput).content : errorMessage,
        ...(!ok && { is_error: true }),
      },
      component,
      events,
    };
  }
}

/** Card kinds whose data comes only from the tool input, so history keeps it as rendered. */
export const STATIC_KINDS = new Set(["choices", "camera_request", "recap"]);
