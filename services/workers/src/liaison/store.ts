import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { InquiryContext, LiaisonStore } from "./answer.js";

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`${op}: ${error?.message ?? "unknown error"}`);
}

const InquiryRow = z.object({
  id: z.string(),
  user_id: z.string(),
  status: z.enum(["pending", "yes", "no", "expired"]),
  asks: z.object({ raw_text: z.string(), title: z.string().nullable() }),
  items: z.object({
    title: z.string(),
    category: z.string().nullable(),
    brand: z.string().nullable(),
    condition_grade: z.string().nullable(),
    value_low_cents: z.number().int().nullable(),
    value_high_cents: z.number().int().nullable(),
  }),
});

export class SupabaseLiaisonStore implements LiaisonStore {
  constructor(private readonly db: SupabaseClient) {}

  async loadInquiry(id: string): Promise<InquiryContext | null> {
    const { data, error } = await this.db
      .from("inquiries")
      .select(
        "id, user_id, status, asks(raw_text, title), items(title, category, brand, condition_grade, value_low_cents, value_high_cents)",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) fail("loadInquiry", error);
    if (!data) return null;
    const row = InquiryRow.parse(data);
    const facts = await this.db
      .from("taste_facts")
      .select("key, value, category")
      .eq("user_id", row.user_id)
      .eq("status", "active")
      .in("category", ["limits", "hunting", "interests", "style"])
      .limit(20);
    if (facts.error) fail("loadInquiry.facts", facts.error);
    return {
      id: row.id,
      userId: row.user_id,
      status: row.status,
      ask: { rawText: row.asks.raw_text, title: row.asks.title },
      item: {
        title: row.items.title,
        category: row.items.category,
        brand: row.items.brand,
        conditionGrade: row.items.condition_grade,
        valueLowCents: row.items.value_low_cents,
        valueHighCents: row.items.value_high_cents,
      },
      facts: z
        .array(z.object({ key: z.string(), value: z.string(), category: z.string() }))
        .parse(facts.data ?? []),
    };
  }

  async answerInquiry(userId: string, id: string, yes: boolean, reason: string | null) {
    const { data, error } = await this.db.rpc("answer_inquiry", {
      p_user_id: userId,
      p_inquiry_id: id,
      p_yes: yes,
      p_by: "gm",
      p_reason: reason,
    });
    if (error) fail("answerInquiry", error);
    return z.object({ result: z.enum(["ok", "not_found", "closed"]) }).parse(data).result;
  }
}
