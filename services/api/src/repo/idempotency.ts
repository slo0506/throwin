export interface IdempotencyRef {
  userId: string;
  key: string;
  method: string;
  path: string;
}

export interface StoredResponse {
  status: number;
  body: string;
  contentType: string | null;
}

export type BeginResult =
  | { kind: "started" }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

/** Keys live for 24 hours, long enough to cover mobile retries. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyStore {
  /** Claims the key, or reports what is already stored under it. */
  begin(ref: IdempotencyRef, requestHash: string, now: Date): Promise<BeginResult>;
  complete(ref: IdempotencyRef, response: StoredResponse): Promise<void>;
  /** Forgets a claimed key so the client can retry, used after server errors. */
  release(ref: IdempotencyRef): Promise<void>;
}

interface MemoryRecord {
  requestHash: string;
  expiresAt: number;
  response: StoredResponse | null;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, MemoryRecord>();

  static #id(ref: IdempotencyRef): string {
    return JSON.stringify([ref.userId, ref.key, ref.method, ref.path]);
  }

  async begin(ref: IdempotencyRef, requestHash: string, now: Date): Promise<BeginResult> {
    const id = MemoryIdempotencyStore.#id(ref);
    const existing = this.#records.get(id);
    if (existing && existing.expiresAt > now.getTime()) {
      if (existing.requestHash !== requestHash) return { kind: "mismatch" };
      if (!existing.response) return { kind: "in_progress" };
      return { kind: "replay", response: existing.response };
    }
    this.#records.set(id, {
      requestHash,
      expiresAt: now.getTime() + IDEMPOTENCY_TTL_MS,
      response: null,
    });
    return { kind: "started" };
  }

  async complete(ref: IdempotencyRef, response: StoredResponse): Promise<void> {
    const record = this.#records.get(MemoryIdempotencyStore.#id(ref));
    if (record) record.response = response;
  }

  async release(ref: IdempotencyRef): Promise<void> {
    this.#records.delete(MemoryIdempotencyStore.#id(ref));
  }
}
