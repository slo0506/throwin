/** Item embeddings with Voyage's multimodal model (text and image in 1 vector space). */
export interface Embedder {
  readonly model: string;
  embed(text: string, jpeg: Buffer): Promise<number[]>;
}

export class VoyageEmbedder implements Embedder {
  readonly model = "voyage-multimodal-3.5";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(text: string, jpeg: Buffer): Promise<number[]> {
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
    if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vector = body.data?.[0]?.embedding;
    if (!vector || vector.length === 0) throw new Error("voyage returned no embedding");
    return vector;
  }
}
