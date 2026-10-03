import type { Context } from "hono";
import type { z } from "zod";
import { HttpError } from "./errors.js";

/** Parses a JSON body against a schema, mapping failures to 400s with readable messages. */
export async function parseJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new HttpError(400, "validation_error", message);
  }
  return result.data;
}
