import { z } from "zod";
import type { GmPrompts } from "../prompts.js";
import { getAskStatus, resolveTarget, setOfferSet, upsertAsk } from "./asks.js";
import { defineTool, type GmTool, ToolError, ToolRegistry } from "./registry.js";
import { presentAsk, presentChoices, presentItems, presentRecap, requestMedia } from "./render.js";
import { getItem, searchMyShelf, searchNetwork, updateItem } from "./shelf.js";

/** Skills the session summary inlines instead of loading on demand. */
const INLINE_SKILLS = new Set(["intake"]);

function loadSkill(prompts: GmPrompts) {
  const names = [...prompts.skills.keys()].filter((n) => !INLINE_SKILLS.has(n)).sort();
  return defineTool({
    name: "load_skill",
    description: `Load a skill's instructions when the turn needs them. Skills: ${names
      .map((n) => `${n} (${prompts.skills.get(n)?.description ?? ""})`)
      .join("; ")}.`,
    kind: "meta",
    input: z.object({ name: z.string() }),
    progress: null,
    async run(_ctx, input) {
      const skill = prompts.skills.get(input.name);
      if (!skill || INLINE_SKILLS.has(input.name)) {
        throw new ToolError(
          "not_found",
          `No skill named ${input.name}. Skills: ${names.join(", ")}.`,
        );
      }
      return { content: skill.body };
    },
  });
}

export const finishIntake = defineTool({
  name: "finish_intake",
  description:
    "End the intake once the user has an Ask and has seen the recap. Switches the conversation to normal chat.",
  kind: "write",
  input: z.object({}),
  progress: null,
  async run(ctx) {
    if (ctx.session.mode !== "intake") {
      throw new ToolError("not_in_intake", "The intake is already finished.");
    }
    const asks = await ctx.data.listActiveAsks(ctx.userId);
    if (asks.length === 0) {
      throw new ToolError(
        "no_ask",
        "The user has no Ask yet. Make 1 with resolve_target and upsert_ask first.",
      );
    }
    if (!ctx.session.recapShown) {
      throw new ToolError("no_recap", "Show the recap with present_recap first.");
    }
    ctx.session.mode = "chat";
    return {
      content: "Intake finished. From now on this is a normal chat.",
      summary: "Finished your intro chat",
    };
  },
});

/** Every GM tool in a fixed order, so the definitions block caches for every user. */
export function gmTools(prompts: GmPrompts): GmTool[] {
  return [
    searchMyShelf,
    searchNetwork,
    getItem,
    resolveTarget,
    upsertAsk,
    setOfferSet,
    updateItem,
    getAskStatus,
    presentItems,
    presentChoices,
    requestMedia,
    presentAsk,
    presentRecap,
    finishIntake,
    loadSkill(prompts),
  ] as GmTool[];
}

export const createToolRegistry = (prompts: GmPrompts) => new ToolRegistry(gmTools(prompts));

/** There is deliberately no tool that approves a Deal, moves money or releases an Item. */
export const FORBIDDEN_TOOL_NAMES = [
  "approve_deal",
  "pay",
  "release_item",
  "send_message_to_user",
  "record_taste_fact",
] as const;
