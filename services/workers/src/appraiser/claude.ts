import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { PreparedImage } from "./images.js";
import {
  DETECT_SYSTEM,
  IDENTIFY_SYSTEM,
  PRICE_SYSTEM,
  PROMPT_VERSION,
  SAME_ITEM_SYSTEM,
  VALUE_EXTRACT_SYSTEM,
} from "./prompts.js";
import {
  Detection,
  detectionJsonSchema,
  Identification,
  identificationJsonSchema,
  SameItem,
  sameItemJsonSchema,
  ValueEstimate,
  valueJsonSchema,
} from "./schemas.js";

export const MODELS = {
  /** High volume and sub-agent work (PRD agent roster). */
  fast: "claude-haiku-4-5-20251001",
  /** Identification and pricing. */
  smart: "claude-sonnet-5-5",
} as const;

/** USD per million tokens. Verify against current pricing before relying on cost dashboards. */
const PRICES: Record<string, { input: number; output: number }> = {
  [MODELS.fast]: { input: 1, output: 5 },
  [MODELS.smart]: { input: 3, output: 15 },
};
const WEB_SEARCH_USD = 0.01;

export interface ModelRun {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCents: number;
  latencyMs: number;
  outcome: string;
}

/** What the Appraiser needs from Claude. A fake implements it in tests. */
export interface Vision {
  detect(frames: PreparedImage[]): Promise<Detection>;
  identify(crops: PreparedImage[], context: PreparedImage, hint: string): Promise<Identification>;
  /** True when 2 detections in 1 frame are really 1 thing to trade. */
  sameItem(
    context: PreparedImage,
    a: { crop: PreparedImage; title: string },
    b: { crop: PreparedImage; title: string },
  ): Promise<boolean>;
  price(item: Identification): Promise<{ value: ValueEstimate | null; research: string }>;
}

type ImageBlock = Anthropic.ImageBlockParam;
type TextBlock = Anthropic.TextBlockParam;

const imageBlock = (img: PreparedImage): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: "image/jpeg", data: img.jpeg.toString("base64") },
});

export class ClaudeVision implements Vision {
  constructor(
    private readonly client: Anthropic,
    private readonly onRun: (run: ModelRun) => void = () => {},
  ) {}

  async detect(frames: PreparedImage[]): Promise<Detection> {
    const content: (ImageBlock | TextBlock)[] = [];
    frames.forEach((frame, i) => {
      content.push({ type: "text", text: `Image ${i}:` });
      content.push(imageBlock(frame));
    });
    content.push({
      type: "text",
      text: `${frames.length} images. Report every distinct tradeable object.`,
    });
    return this.#structured("appraiser.detect", MODELS.fast, DETECT_SYSTEM, content, {
      schema: detectionJsonSchema,
      parser: Detection,
      maxTokens: 4000,
    });
  }

  async identify(
    crops: PreparedImage[],
    context: PreparedImage,
    hint: string,
  ): Promise<Identification> {
    const content: (ImageBlock | TextBlock)[] = [
      { type: "text", text: `Close-ups of the item (a detector labeled it "${hint}"):` },
      ...crops.map(imageBlock),
      { type: "text", text: "The wider frame it came from:" },
      imageBlock(context),
    ];
    return this.#structured("appraiser.identify", MODELS.smart, IDENTIFY_SYSTEM, content, {
      schema: identificationJsonSchema,
      parser: Identification,
      maxTokens: 2000,
    });
  }

  async sameItem(
    context: PreparedImage,
    a: { crop: PreparedImage; title: string },
    b: { crop: PreparedImage; title: string },
  ): Promise<boolean> {
    const result = await this.#structured(
      "appraiser.same_item",
      MODELS.fast,
      SAME_ITEM_SYSTEM,
      [
        { type: "text", text: "The photo:" },
        imageBlock(context),
        { type: "text", text: `A (read as "${a.title}"):` },
        imageBlock(a.crop),
        { type: "text", text: `B (read as "${b.title}"):` },
        imageBlock(b.crop),
      ],
      { schema: sameItemJsonSchema, parser: SameItem, maxTokens: 300 },
    );
    return result.same;
  }

  async price(item: Identification): Promise<{ value: ValueEstimate | null; research: string }> {
    const description = [
      `Item: ${item.title}`,
      item.brand && `Brand: ${item.brand}`,
      item.model && `Model or set: ${item.model}`,
      item.variant && `Variant: ${item.variant}`,
      `Condition: ${item.condition_grade}${item.defects.length ? ` (${item.defects.join("; ")})` : ""}`,
      Object.keys(item.attributes).length ? `Details: ${JSON.stringify(item.attributes)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    let research: string;
    try {
      research = await this.#research(description, true);
    } catch (err) {
      // Web search can be disabled for an org. Fall back to the model's own knowledge.
      if (!(err instanceof Anthropic.APIError) || err.status === undefined || err.status >= 500)
        throw err;
      research = `No web access. ${await this.#research(description, false)}`;
    }

    try {
      const value = await this.#structured(
        "appraiser.price.extract",
        MODELS.fast,
        VALUE_EXTRACT_SYSTEM,
        [{ type: "text", text: `Item:\n${description}\n\nResearch notes:\n${research}` }],
        {
          schema: valueJsonSchema,
          parser: ValueEstimate,
          maxTokens: 800,
        },
      );
      return { value, research };
    } catch {
      return { value: null, research };
    }
  }

  async #research(description: string, withSearch: boolean): Promise<string> {
    const started = Date.now();
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `What does this trade for, used, in the US today?\n\n${description}`,
      },
    ];
    const tools: Anthropic.ToolUnion[] = withSearch
      ? [{ type: "web_search_20260318", name: "web_search", max_uses: 4 }]
      : [];
    let text = "";
    let searches = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // Server tools can pause a long turn; send it back to let it continue (at most 3 times).
    for (let turn = 0; turn < 3; turn++) {
      const res = await this.client.messages.create({
        model: MODELS.smart,
        max_tokens: 1500,
        system: PRICE_SYSTEM,
        messages,
        ...(tools.length ? { tools } : {}),
      });
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
      searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content });
    }

    this.#record("appraiser.price.research", MODELS.smart, usage, started, "ok", searches);
    return text.slice(0, 6000);
  }

  async #structured<T extends z.ZodType>(
    agent: string,
    model: string,
    system: string,
    content: (ImageBlock | TextBlock)[],
    spec: { schema: object; parser: T; maxTokens: number },
  ): Promise<z.output<T>> {
    const started = Date.now();
    const res = await this.client.messages.create({
      model,
      max_tokens: spec.maxTokens,
      system: `${system}\n\n(${PROMPT_VERSION})`,
      output_config: {
        format: { type: "json_schema", schema: spec.schema as Record<string, unknown> },
      },
      messages: [{ role: "user", content }],
    });
    const usage = {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    };
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = spec.parser.safeParse(json);
    this.#record(agent, model, usage, started, parsed.success ? "ok" : "invalid_output");
    if (!parsed.success) {
      throw new Error(
        `${agent}: invalid output (${res.stop_reason}): ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    return parsed.data;
  }

  #record(
    agent: string,
    model: string,
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
    started: number,
    outcome: string,
    searches = 0,
  ) {
    const price = PRICES[model] ?? { input: 3, output: 15 };
    const usd =
      (usage.input * price.input +
        usage.cacheWrite * price.input * 1.25 +
        usage.cacheRead * price.input * 0.1 +
        usage.output * price.output) /
        1_000_000 +
      searches * WEB_SEARCH_USD;
    this.onRun({
      agent,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costCents: Math.round(usd * 100 * 10000) / 10000,
      latencyMs: Date.now() - started,
      outcome,
    });
  }
}
