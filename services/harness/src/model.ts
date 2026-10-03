import Anthropic from "@anthropic-ai/sdk";

export const GM_MODELS = {
  /** The GM loop and product research (PRD agent roster). */
  gm: "claude-sonnet-5-5",
  /** Structured extraction after research. */
  fast: "claude-haiku-4-5-20251001",
} as const;

/** USD per million tokens. Verify against current pricing before relying on dashboards. */
const PRICES: Record<string, { input: number; output: number }> = {
  [GM_MODELS.fast]: { input: 1, output: 5 },
  [GM_MODELS.gm]: { input: 3, output: 15 },
};
const WEB_SEARCH_USD = 0.01;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(total: TokenUsage, usage: Anthropic.Usage): TokenUsage {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  return total;
}

/** Cost as `agent_runs.cost_cents`, priced like the workers (cache writes 1.25x, reads 0.1x). */
export function costCents(model: string, usage: TokenUsage, searches = 0): number {
  const price = PRICES[model] ?? { input: 3, output: 15 };
  const usd =
    (usage.input * price.input +
      usage.cacheWrite * price.input * 1.25 +
      usage.cacheRead * price.input * 0.1 +
      usage.output * price.output) /
      1_000_000 +
    searches * WEB_SEARCH_USD;
  return Math.round(usd * 100 * 10000) / 10000;
}

export type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** The 2 ways the harness calls Claude. A fake implements it in tests. */
export interface ModelClient {
  /** Streams 1 response, calling `onText` with each text delta, and returns the final message. */
  stream(params: CreateParams, onText: (delta: string) => void): Promise<Anthropic.Message>;
  create(params: CreateParams): Promise<Anthropic.Message>;
}

export class AnthropicModelClient implements ModelClient {
  constructor(private readonly client: Anthropic) {}

  static fromApiKey(apiKey: string, maxRetries = 3): AnthropicModelClient {
    return new AnthropicModelClient(new Anthropic({ apiKey, maxRetries }));
  }

  async stream(params: CreateParams, onText: (delta: string) => void): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(params);
    stream.on("text", (delta) => onText(delta));
    return stream.finalMessage();
  }

  create(params: CreateParams): Promise<Anthropic.Message> {
    return this.client.messages.create(params);
  }
}

/**
 * Web search version per model: dynamic filtering (web_search_20260209 and later) needs
 * Claude 4.6 or later, so Haiku 4.5 uses basic search.
 */
export function webSearchTool(model: string, maxUses: number): Anthropic.ToolUnion {
  return model === GM_MODELS.fast
    ? { type: "web_search_20250305", name: "web_search", max_uses: maxUses }
    : { type: "web_search_20260318", name: "web_search", max_uses: maxUses };
}
