import type { SupabaseClient } from "@supabase/supabase-js";
import { RepositoryError } from "./supabase.js";

export const MEDIA_BUCKET = "item-media";

/** Signed access to the private media bucket. Clients never get the service key. */
export interface MediaStore {
  /** A URL the client can PUT 1 file to, valid for 2 hours. */
  createUploadUrl(path: string): Promise<string>;
  /** Signed read URLs, valid for 1 hour. Missing paths map to null. */
  signedReadUrls(paths: string[]): Promise<Map<string, string | null>>;
}

export class SupabaseMediaStore implements MediaStore {
  constructor(private readonly db: SupabaseClient) {}

  async createUploadUrl(path: string): Promise<string> {
    const { data, error } = await this.db.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
    if (error || !data)
      throw new RepositoryError("media.createUploadUrl", error ?? { message: "no data" });
    return data.signedUrl;
  }

  async signedReadUrls(paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (paths.length === 0) return out;
    const { data, error } = await this.db.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600);
    if (error) throw new RepositoryError("media.signedReadUrls", error);
    for (const row of data ?? []) {
      if (row.path) out.set(row.path, row.signedUrl ?? null);
    }
    return out;
  }
}

/** Test double: deterministic fake URLs. */
export class MemoryMediaStore implements MediaStore {
  readonly uploads: string[] = [];

  async createUploadUrl(path: string): Promise<string> {
    this.uploads.push(path);
    return `https://storage.test/upload/${path}?token=t`;
  }

  async signedReadUrls(paths: string[]): Promise<Map<string, string | null>> {
    return new Map(paths.map((p) => [p, `https://storage.test/read/${p}?token=t`]));
  }
}
