import type { SupabaseClient } from "@supabase/supabase-js";
import { TasteFactCategory } from "@throwin/shared";
import type { ModelRun } from "../appraiser/claude.js";
import type { MemoryEvent, MemoryStore, NewFact } from "./extract.js";
import type { StoredMessage } from "./text.js";
import type { ExistingFact } from "./validator.js";

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`${op}: ${error?.message ?? "unknown error"}`);
}

/** unique_violation (duplicate active fact) and check_violation (over 40 active facts). */
const REFUSED = new Set(["23505", "23514"]);

/** The extractor's database access with the service role, scoped by user in every query. */
export class SupabaseMemoryStore implements MemoryStore {
  constructor(private readonly db: SupabaseClient) {}

  async loadMessages(
    userId: string,
    conversationId: string,
    messageIds: string[],
  ): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from("messages")
      .select("id, role, content, created_at")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .in("id", messageIds);
    if (error) fail("loadMessages", error);
    return (
      (data ?? []) as { id: string; role: string; content: unknown; created_at: string }[]
    ).flatMap((m) =>
      m.role === "user" || m.role === "assistant"
        ? [{ id: m.id, role: m.role, content: m.content, createdAt: new Date(m.created_at) }]
        : [],
    );
  }

  async conversationMode(userId: string, conversationId: string) {
    // select * so this works whether or not the harness's migration added a mode column.
    const { data, error } = await this.db
      .from("conversations")
      .select("*")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("conversationMode", error);
    const mode = (data as { mode?: unknown } | null)?.mode;
    return mode === "intake" || mode === "chat" ? mode : null;
  }

  async loadFacts(userId: string): Promise<ExistingFact[]> {
    const { data, error } = await this.db
      .from("taste_facts")
      .select("id, key, value, category, always_on, status")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(2000);
    if (error) fail("loadFacts", error);
    return (
      (data ?? []) as {
        id: string;
        key: string;
        value: string;
        category: string;
        always_on: boolean;
        status: ExistingFact["status"];
      }[]
    ).map((r) => {
      const category = TasteFactCategory.safeParse(r.category);
      return {
        id: r.id,
        key: r.key,
        value: r.value,
        category: category.success ? category.data : "preferences",
        alwaysOn: r.always_on,
        status: r.status,
      };
    });
  }

  async otherNames(userId: string): Promise<string[]> {
    const mine = await this.db.from("circle_members").select("circle_id").eq("user_id", userId);
    if (mine.error) fail("otherNames.circles", mine.error);
    const circles = ((mine.data ?? []) as { circle_id: string }[]).map((r) => r.circle_id);
    if (circles.length === 0) return [];
    const { data, error } = await this.db
      .from("circle_members")
      .select("user_id, users(display_name)")
      .in("circle_id", circles)
      .neq("user_id", userId)
      .limit(1000);
    if (error) fail("otherNames.members", error);
    const names = new Set<string>();
    for (const row of (data ?? []) as {
      users: { display_name: string | null } | { display_name: string | null }[] | null;
    }[]) {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      const first = user?.display_name?.trim().split(/\s+/)[0];
      if (first) names.add(first);
    }
    return [...names];
  }

  async insertRun(userId: string, run: ModelRun, trigger: string): Promise<string> {
    const { data, error } = await this.db
      .from("agent_runs")
      .insert({
        agent: run.agent,
        trigger,
        user_id: userId,
        model: run.model,
        input_tokens: run.inputTokens,
        output_tokens: run.outputTokens,
        cache_read_tokens: run.cacheReadTokens,
        cache_write_tokens: run.cacheWriteTokens,
        cost_cents: run.costCents,
        latency_ms: run.latencyMs,
        outcome: run.outcome,
      })
      .select("id")
      .single();
    if (error) fail("insertRun", error);
    return (data as { id: string }).id;
  }

  async createFact(userId: string, fact: NewFact): Promise<string | null> {
    const { data, error } = await this.db
      .from("taste_facts")
      .insert({
        user_id: userId,
        key: fact.key,
        value: fact.value,
        category: fact.category,
        always_on: fact.alwaysOn,
        source: fact.source,
        source_session_id: fact.sourceSessionId,
        confidence: fact.confidence,
      })
      .select("id")
      .single();
    if (error?.code && REFUSED.has(error.code)) return null;
    if (error) fail("createFact", error);
    return (data as { id: string }).id;
  }

  async setFactStatus(
    userId: string,
    factId: string,
    from: ExistingFact["status"],
    to: ExistingFact["status"],
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from("taste_facts")
      .update({ status: to })
      .eq("id", factId)
      .eq("user_id", userId)
      .eq("status", from)
      .select("id");
    if (error?.code && REFUSED.has(error.code)) return false;
    if (error) fail("setFactStatus", error);
    return (data ?? []).length > 0;
  }

  async recordEvent(event: MemoryEvent): Promise<void> {
    const { error } = await this.db.from("agent_events").insert({
      run_id: event.runId,
      user_id: event.userId,
      type: event.type,
      user_visible: event.userVisible,
      summary: event.summary,
      payload: event.payload,
    });
    if (error) fail("recordEvent", error);
  }
}
