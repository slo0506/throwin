import { randomUUID } from "node:crypto";
import type { AutonomyLevel, ItemWillingness } from "@throwin/shared";
import {
  ACTIVE_ASK_STATUSES,
  type AgentEvent,
  type AgentRun,
  type AskPatch,
  type AskRecord,
  type AskUpdateResult,
  type CircleStats,
  type Conversation,
  type GmData,
  type GmUser,
  type LoadedImage,
  type NetworkItem,
  type NetworkQuery,
  type NewAsk,
  type OwnItem,
  SHELF_STATUSES,
  type StoredMessage,
  type TasteFact,
} from "./data.js";
import { finishedIntakeIn } from "./history.js";

const words = (q: string | undefined) =>
  (q ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

const matches = (text: string, q: string | undefined) => {
  const want = words(q);
  if (want.length === 0) return true;
  const hay = text.toLowerCase();
  return want.some((w) => hay.includes(w));
};

/** In-memory GmData for tests and offline evals. Same scoping rules as Supabase. */
export class MemoryGmData implements GmData {
  readonly users = new Map<string, GmUser>();
  readonly items: OwnItem[] = [];
  /** Network-visible view of other users' Items: who can see them is `circles`. */
  readonly networkItems: NetworkItem[] = [];
  /** user ID → Circle IDs. */
  readonly circles = new Map<string, string[]>();
  readonly blocks: { blocker: string; blocked: string }[] = [];
  readonly asks: AskRecord[] = [];
  readonly facts = new Map<string, TasteFact[]>();
  readonly conversations: Conversation[] = [];
  readonly messages: StoredMessage[] = [];
  readonly runs: AgentRun[] = [];
  readonly events: AgentEvent[] = [];
  readonly jobs: { kind: string; payload: Record<string, unknown> }[] = [];
  readonly images = new Map<string, LoadedImage>();
  /** What circle_demand would return, by user. Tests and evals set it. */
  readonly demand = new Map<
    string,
    { label: string; category: string | null; askers: number; itemIds: string[] }[]
  >();
  now: () => Date = () => new Date();
  /** When each run was recorded, for spend windows. */
  readonly #runTimes = new Map<string, Date>();

  addUser(id: string, overrides: Partial<GmUser> = {}): GmUser {
    const user: GmUser = { id, firstName: null, autonomy: "every_deal", ...overrides };
    this.users.set(id, user);
    return user;
  }

  addItem(item: Partial<OwnItem> & Pick<OwnItem, "id" | "ownerId">): OwnItem {
    const at = this.now();
    const record: OwnItem = {
      status: "on_shelf",
      title: "",
      willingness: "would_trade",
      category: null,
      brand: null,
      model: null,
      variant: null,
      conditionGrade: null,
      defects: [],
      valueLowCents: null,
      valueMidCents: null,
      valueHighCents: null,
      identityConf: null,
      conditionConf: null,
      reserved: false,
      appraising: false,
      readiness: "identified",
      photoScore: null,
      photoIssues: [],
      missingAngles: [],
      description: null,
      openQuestions: 0,
      followUp: null,
      thumbnailPath: null,
      createdAt: at,
      updatedAt: at,
      ...item,
    };
    this.items.push(record);
    return record;
  }

  addNetworkItem(item: Partial<NetworkItem> & Pick<NetworkItem, "id" | "ownerId">): NetworkItem {
    const record: NetworkItem = {
      ownerFirstName: "Someone",
      title: "",
      category: null,
      brand: null,
      model: null,
      conditionGrade: null,
      valueLowCents: null,
      valueMidCents: null,
      valueHighCents: null,
      readiness: "showcase",
      description: null,
      thumbnailPath: null,
      ...item,
    };
    this.networkItems.push(record);
    return record;
  }

  joinCircle(userId: string, circleId: string) {
    this.circles.set(userId, [...(this.circles.get(userId) ?? []), circleId]);
  }

  async getUser(userId: string) {
    return this.users.get(userId) ?? null;
  }

  async listShelfItems(userId: string) {
    return this.items
      .filter((i) => i.ownerId === userId && SHELF_STATUSES.includes(i.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async getOwnItems(userId: string, ids: string[]) {
    const want = new Set(ids);
    return this.items.filter(
      (i) => i.ownerId === userId && want.has(i.id) && SHELF_STATUSES.includes(i.status),
    );
  }

  async setItemWillingness(userId: string, itemId: string, willingness: ItemWillingness) {
    const item = this.items.find(
      (i) => i.id === itemId && i.ownerId === userId && SHELF_STATUSES.includes(i.status),
    );
    if (!item) return null;
    item.willingness = willingness;
    item.updatedAt = this.now();
    return item;
  }

  #coMembers(userId: string): Set<string> {
    const mine = new Set(this.circles.get(userId) ?? []);
    const out = new Set<string>();
    for (const [other, circles] of this.circles) {
      if (other === userId) continue;
      if (circles.some((c) => mine.has(c))) out.add(other);
    }
    for (const b of this.blocks) {
      if (b.blocker === userId) out.delete(b.blocked);
      if (b.blocked === userId) out.delete(b.blocker);
    }
    return out;
  }

  async listNetworkItems(userId: string, query: NetworkQuery) {
    const members = this.#coMembers(userId);
    const ids = query.ids ? new Set(query.ids) : null;
    return this.networkItems
      .filter((i) => members.has(i.ownerId) && i.readiness === "showcase")
      .filter((i) => !ids || ids.has(i.id))
      .filter((i) =>
        matches([i.title, i.brand, i.model, i.category].filter(Boolean).join(" "), query.query),
      )
      .slice(0, query.limit);
  }

  async circleStats(userId: string): Promise<CircleStats> {
    return {
      circles: (this.circles.get(userId) ?? []).length,
      shelves: this.#coMembers(userId).size,
    };
  }

  async listActiveAsks(userId: string) {
    return this.asks
      .filter((a) => a.userId === userId && ACTIVE_ASK_STATUSES.includes(a.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async setAutonomy(userId: string, level: AutonomyLevel) {
    const user = this.users.get(userId);
    if (user) user.autonomy = level;
    for (const ask of this.asks) {
      if (ask.userId === userId && ACTIVE_ASK_STATUSES.includes(ask.status)) ask.autonomy = level;
    }
  }

  async getAsk(userId: string, askId: string) {
    return this.asks.find((a) => a.id === askId && a.userId === userId) ?? null;
  }

  async createAsk(userId: string, ask: NewAsk) {
    const at = this.now();
    const record: AskRecord = {
      id: randomUUID(),
      userId,
      ...ask,
      maxItems: ask.maxItems ?? 1,
      cashCeilingCents: 0,
      offerItemIds: [],
      createdAt: at,
      updatedAt: at,
    };
    this.asks.push(record);
    return record;
  }

  /** Mirrors public.patch_ask. */
  async updateAsk(userId: string, askId: string, patch: AskPatch): Promise<AskUpdateResult> {
    const ask = await this.getAsk(userId, askId);
    if (!ask) return "not_found";
    if (["fulfilled", "expired", "cancelled"].includes(ask.status)) return "ask_closed";
    let status = ask.status;
    if (patch.offerItemIds) {
      const ids = [...new Set(patch.offerItemIds)];
      const valid = ids.every((id) =>
        this.items.some(
          (i) => i.id === id && i.ownerId === userId && i.status === "on_shelf" && !i.reserved,
        ),
      );
      if (!valid) return "invalid_offer_item";
      ask.offerItemIds = ids;
      if (ids.length > 0 && (status === "drafting" || status === "offering"))
        status = "prospecting";
    }
    if (patch.target !== undefined && status === "drafting") status = "offering";
    const { offerItemIds: _ids, ...fields } = patch;
    Object.assign(ask, fields, { status, updatedAt: this.now() });
    return ask;
  }

  async listAlwaysOnFacts(userId: string) {
    return this.facts.get(userId) ?? [];
  }

  async latestConversation(userId: string) {
    return (await this.listConversations(userId, 1))[0] ?? null;
  }

  async getConversation(userId: string, conversationId: string) {
    return this.conversations.find((c) => c.id === conversationId && c.userId === userId) ?? null;
  }

  async listConversations(userId: string, limit: number) {
    return this.conversations
      .filter((c) => c.userId === userId)
      .map((c, order) => ({ c, order }))
      .sort((a, b) => b.c.updatedAt.getTime() - a.c.updatedAt.getTime() || b.order - a.order)
      .map(({ c }) => c)
      .slice(0, limit);
  }

  async firstConversation(userId: string) {
    return this.conversations.find((c) => c.userId === userId) ?? null;
  }

  async createConversation(userId: string) {
    const at = this.now();
    const conversation: Conversation = {
      id: randomUUID(),
      userId,
      title: null,
      createdAt: at,
      updatedAt: at,
    };
    this.conversations.push(conversation);
    return conversation;
  }

  async setConversationTitle(userId: string, conversationId: string, title: string) {
    const c = await this.getConversation(userId, conversationId);
    if (c) c.title = title;
  }

  async listMessages(userId: string, conversationId: string, limit: number) {
    const rows = this.messages
      .filter((m) => m.userId === userId && m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async appendMessages(rows: StoredMessage[]) {
    this.messages.push(...rows.map((r) => structuredClone(r)));
    const touched = this.conversations.find((c) => c.id === rows[0]?.conversationId);
    const last = rows.at(-1)?.createdAt;
    if (touched && last && last > touched.updatedAt) touched.updatedAt = last;
  }

  async intakeFinished(userId: string) {
    return finishedIntakeIn(this.messages.filter((m) => m.userId === userId));
  }

  async circleDemand(userId: string) {
    const rows = this.demand.get(userId) ?? [];
    const own = await this.getOwnItems(
      userId,
      rows.flatMap((r) => r.itemIds),
    );
    return rows.map((r) => ({
      label: r.label,
      category: r.category,
      askers: r.askers,
      items: own.filter((i) => r.itemIds.includes(i.id)),
    }));
  }

  async recordRun(run: AgentRun) {
    this.runs.push(run);
    this.#runTimes.set(run.id, this.now());
  }

  async gmSpendCents(since: Date, userId: string | null) {
    return this.runs
      .filter((r) => r.agent === "gm" && (userId === null || r.userId === userId))
      .filter((r) => (this.#runTimes.get(r.id) ?? this.now()) >= since)
      .reduce((sum, r) => sum + r.costCents, 0);
  }

  async recordEvents(events: AgentEvent[]) {
    this.events.push(...events);
  }

  async enqueueJob(kind: string, payload: Record<string, unknown>) {
    this.jobs.push({ kind, payload });
  }

  async signedUrls(paths: string[]) {
    return new Map(paths.map((p) => [p, `https://storage.test/read/${p}?token=t`] as const));
  }

  async loadImage(userId: string, path: string) {
    if (!path.startsWith(`${userId}/`)) return null;
    return this.images.get(path) ?? null;
  }
}
