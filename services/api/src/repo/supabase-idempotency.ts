import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  type BeginResult,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyRef,
  type IdempotencyStore,
  type StoredResponse,
} from "./idempotency.js";
import { RepositoryError } from "./supabase.js";

const Row = z.object({
  request_hash: z.string(),
  expires_at: z.string(),
  response_status: z.number().int().nullable(),
  response_body: z.string().nullable(),
  response_content_type: z.string().nullable(),
});

const UNIQUE_VIOLATION = "23505";

/** Idempotency records in public.idempotency_keys (service role only, RLS has no policies). */
export class SupabaseIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: SupabaseClient) {}

  #match(ref: IdempotencyRef) {
    return { user_id: ref.userId, key: ref.key, method: ref.method, path: ref.path };
  }

  async begin(ref: IdempotencyRef, requestHash: string, now: Date): Promise<BeginResult> {
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
    // Clear an expired record first so the insert below can claim the key.
    const { error: purgeError } = await this.db
      .from("idempotency_keys")
      .delete()
      .match(this.#match(ref))
      .lt("expires_at", now.toISOString());
    if (purgeError) throw new RepositoryError("idempotency.purge", purgeError);

    const { error } = await this.db
      .from("idempotency_keys")
      .insert({ ...this.#match(ref), request_hash: requestHash, expires_at: expiresAt });
    if (!error) return { kind: "started" };
    if (error.code !== UNIQUE_VIOLATION) throw new RepositoryError("idempotency.begin", error);

    const { data, error: readError } = await this.db
      .from("idempotency_keys")
      .select("request_hash, expires_at, response_status, response_body, response_content_type")
      .match(this.#match(ref))
      .maybeSingle();
    if (readError) throw new RepositoryError("idempotency.read", readError);
    if (!data) return { kind: "in_progress" };
    const row = Row.parse(data);
    if (row.request_hash !== requestHash) return { kind: "mismatch" };
    if (row.response_status === null) return { kind: "in_progress" };
    return {
      kind: "replay",
      response: {
        status: row.response_status,
        body: row.response_body ?? "",
        contentType: row.response_content_type,
      },
    };
  }

  async complete(ref: IdempotencyRef, response: StoredResponse): Promise<void> {
    const { error } = await this.db
      .from("idempotency_keys")
      .update({
        response_status: response.status,
        response_body: response.body,
        response_content_type: response.contentType,
        completed_at: new Date().toISOString(),
      })
      .match(this.#match(ref));
    if (error) throw new RepositoryError("idempotency.complete", error);
  }

  async release(ref: IdempotencyRef): Promise<void> {
    const { error } = await this.db.from("idempotency_keys").delete().match(this.#match(ref));
    if (error) throw new RepositoryError("idempotency.release", error);
  }
}
