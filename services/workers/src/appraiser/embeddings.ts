/** Item embeddings with Voyage's multimodal model (text and image in 1 vector space). */
export interface Embedder {
  readonly model: string;
  embed(text: string, jpeg: Buffer): Promise<number[]>;
}

class RetryableError extends Error {}

export class VoyageEmbedder implements Embedder {
  readonly model = "voyage-multimodal-3.5";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelaysMs: number[] = [2_000, 8_000, 21_000],
  ) {}

  async embed(text: string, jpeg: Buffer): Promise<number[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#embedOnce(text, jpeg);
      } catch (err) {
        const delay = this.retryDelaysMs[attempt];
        if (!(err instanceof RetryableError) || delay === undefined) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async #embedOnce(text: string, jpeg: Buffer): Promise<number[]> {
    const res = await this.fetchImpl("https://api.voyageai.com/v1/multimodalembeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input_type: "document",
        inputs: [
          {
            content: [
              { type: "text", text },
              {
                type: "image_base64",
                image_base64: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const message = `voyage ${res.status}: ${(await res.text()).slice(0, 300)}`;
      // Rate limits and server errors clear up on their own; anything else will not.
      throw res.status === 429 || res.status >= 500
        ? new RetryableError(message)
        : new Error(message);
    }
    const body = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vector = body.data?.[0]?.embedding;
    if (!vector || vector.length === 0) throw new Error("voyage returned no embedding");
    return vector;
  }
}
