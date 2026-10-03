import { randomUUID } from "node:crypto";
import {
  type CircleRole,
  CLOSED_ASK_STATUSES,
  compareQuestions,
  computeReadiness,
  DEFAULT_NOTIFICATION_PREFS,
  type QuestionKind,
  type QuestionStatus,
} from "@throwin/shared";
import {
  ACTIVE_ASK_STATUSES,
  type AcceptInviteResult,
  type AnswerInput,
  type AnswerResult,
  type AskInsert,
  type AskRecord,
  type AskUpdate,
  type AskUpdateResult,
  type CaptureMediaInput,
  type CaptureRecord,
  type CircleMemberRecord,
  type CircleRecord,
  type InvitePreviewRecord,
  type InviteRecord,
  type ItemRecord,
  type ItemUpdate,
  type MePatch,
  type MeRecord,
  type QuestionRecord,
  type Repository,
  SHELF_STATUSES,
  type TasteFactRecord,
} from "./types.js";

type StoredUser = Omit<MeRecord, "counts">;

/** An Ask as the database holds it: the offer set is a list of Item IDs (offer_sets). */
export type StoredAsk = Omit<AskRecord, "offerItems"> & { offerItemIds: string[] };

/** A Refiner question as the database holds it. */
export interface MemoryQuestion {
  id: string;
  itemId: string;
  kind: QuestionKind;
  prompt: string;
  options: string[];
  driver: string;
  impact: number;
  status: QuestionStatus;
  skipCount: number;
  answer: { value?: string; media?: boolean } | null;
  createdAt: Date;
}

/** In-memory repository for tests and local experiments. */
export class MemoryRepository implements Repository {
  readonly users = new Map<string, StoredUser>();
  readonly items: ItemRecord[] = [];
  readonly questions: MemoryQuestion[] = [];
  /** Items whose owner pinned the identity (items.identity_confirmed). */
  readonly confirmed = new Set<string>();
  readonly asks: StoredAsk[] = [];
  readonly tasteFacts: TasteFactRecord[] = [];
  readonly circles: {
    id: string;
    name: string;
    categoryFocus: string[];
    status: "active" | "paused";
    createdAt: Date;
  }[] = [];
  readonly memberships: {
    userId: string;
    circleId: string;
    role?: CircleRole;
    joinedAt?: Date;
  }[] = [];
  readonly invites: (InviteRecord & { createdBy: string })[] = [];
  readonly captures: CaptureRecord[] = [];
  readonly captureMedia: (CaptureMediaInput & { captureId: string })[] = [];
  readonly itemMedia: (CaptureMediaInput & { itemId: string })[] = [];
  readonly jobs: { kind: string; payload: Record<string, unknown> }[] = [];
  #nextId = 1;

  addUser(id: string, overrides: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id,
      displayName: null,
      photoUrl: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
      deletedAt: null,
      autonomyLevel: "every_deal",
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
      homeArea: null,
      defaultHandoffPlaceId: null,
      ...overrides,
    };
    this.users.set(id, user);
    return user;
  }

  addItem(item: Partial<ItemRecord> & Pick<ItemRecord, "id" | "ownerId">): ItemRecord {
    const record: ItemRecord = {
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
      reservedByDealId: null,
      followUp: null,
      appraising: false,
      readiness: "logged",
      photoScore: null,
      photoIssues: [],
      missingAngles: [],
      description: null,
      openQuestions: 0,
      captureId: null,
      thumbnailPath: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
      updatedAt: new Date("2026-10-03T00:00:00Z"),
      ...item,
    };
    this.items.push(record);
    return this.#sync(record);
  }

  addQuestion(q: Partial<MemoryQuestion> & Pick<MemoryQuestion, "id" | "itemId">): MemoryQuestion {
    const question: MemoryQuestion = {
      kind: "yes_no",
      prompt: "Is this Nike?",
      options: ["Yes", "No", "Not sure"],
      driver: "brand",
      impact: 0.5,
      status: "open",
      skipCount: 0,
      answer: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
      ...q,
    };
    this.questions.push(question);
    return question;
  }

  async getMe(userId: string): Promise<MeRecord | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    return {
      ...user,
      notificationPrefs: { ...user.notificationPrefs },
      counts: {
        shelfItems: this.#shelf(userId).length,
        activeAsks: this.asks.filter(
          (a) => a.userId === userId && ACTIVE_ASK_STATUSES.includes(a.status),
        ).length,
        circles: this.memberships.filter((m) => m.userId === userId).length,
      },
    };
  }

  async updateMe(userId: string, patch: MePatch): Promise<MeRecord | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    if (patch.displayName !== undefined) user.displayName = patch.displayName;
    if (patch.photoUrl !== undefined) user.photoUrl = patch.photoUrl;
    if (patch.autonomyLevel !== undefined) user.autonomyLevel = patch.autonomyLevel;
    if (patch.notificationPrefs) {
      user.notificationPrefs = { ...user.notificationPrefs, ...patch.notificationPrefs };
    }
    return this.getMe(userId);
  }

  async softDeleteUser(userId: string, at: Date): Promise<Date | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    user.deletedAt ??= at;
    return user.deletedAt;
  }

  async listShelfItems(userId: string): Promise<ItemRecord[]> {
    return this.#shelf(userId)
      .map((i) => this.#sync(i))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async updateItem(userId: string, itemId: string, update: ItemUpdate): Promise<ItemRecord | null> {
    const item = this.#shelf(userId).find((i) => i.id === itemId);
    if (!item) return null;
    if (update.title !== undefined) item.title = update.title;
    if (update.willingness !== undefined) item.willingness = update.willingness;
    if (update.conditionGrade !== undefined) item.conditionGrade = update.conditionGrade;
    if (update.confirm) {
      this.confirmed.add(item.id);
      if (item.status === "draft" || item.status === "needs_photos") item.status = "on_shelf";
    }
    return this.#sync(item);
  }

  async getItem(userId: string, itemId: string): Promise<ItemRecord | null> {
    const item = this.items.find(
      (i) => i.id === itemId && i.ownerId === userId && i.status !== "removed",
    );
    return item ? this.#sync(item) : null;
  }

  async submitItemMedia(
    userId: string,
    itemId: string,
    media: CaptureMediaInput[],
  ): Promise<ItemRecord | "not_found" | "conflict"> {
    const item = await this.getItem(userId, itemId);
    if (!item) return "not_found";
    if (item.reservedByDealId || item.status === "traded" || item.appraising) return "conflict";
    for (const m of media) this.itemMedia.push({ ...m, itemId });
    // Photos answer the Item's open photo questions.
    for (const q of this.questions) {
      if (q.itemId === itemId && q.kind === "photo" && q.status === "open") {
        q.status = "answered";
        q.answer = { media: true };
      }
    }
    item.appraising = true;
    this.jobs.push({ kind: "reappraise_item", payload: { item_id: itemId, user_id: userId } });
    return this.#sync(item);
  }

  async removeItem(userId: string, itemId: string): Promise<"removed" | "not_found" | "reserved"> {
    const item = this.#shelf(userId).find((i) => i.id === itemId);
    if (!item) return "not_found";
    if (item.reservedByDealId) return "reserved";
    item.status = "removed";
    return "removed";
  }

  async listOpenQuestions(userId: string, itemId?: string): Promise<QuestionRecord[]> {
    const shelf = new Map(this.#shelf(userId).map((i) => [i.id, i]));
    return this.questions
      .filter((q) => q.status === "open" && shelf.has(q.itemId) && (!itemId || q.itemId === itemId))
      .map((q) => {
        const item = shelf.get(q.itemId) as ItemRecord;
        return {
          id: q.id,
          itemId: q.itemId,
          itemTitle: item.title,
          thumbnailPath: item.thumbnailPath,
          kind: q.kind,
          prompt: q.prompt,
          options: [...q.options],
          impact: q.impact,
          createdAt: q.createdAt,
        };
      });
  }

  /** Mirrors public.answer_item_question. */
  async answerQuestion(
    userId: string,
    questionId: string,
    input: AnswerInput,
  ): Promise<AnswerResult> {
    const question = this.questions.find((q) => q.id === questionId);
    const item = question
      ? this.items.find(
          (i) => i.id === question.itemId && i.ownerId === userId && i.status !== "removed",
        )
      : undefined;
    if (!question || !item) return { result: "not_found" };
    if (question.status !== "open") return { result: "already_answered" };
    if (item.reservedByDealId || item.status === "reserved" || item.status === "traded") {
      return { result: "item_reserved" };
    }
    if ("skip" in input) {
      question.status = "skipped";
      question.skipCount++;
    } else {
      if (question.kind === "photo") return { result: "use_media_upload" };
      const answer = input.answer.trim();
      const valid =
        question.kind === "text"
          ? answer.length >= 1 && answer.length <= 200
          : question.options.includes(answer);
      if (!valid) return { result: "invalid_answer" };
      question.status = "answered";
      question.answer = { value: answer };
    }
    item.appraising = true;
    const queued = this.jobs.some((j) => j.kind === "refine_item" && j.payload.item_id === item.id);
    if (!queued) {
      this.jobs.push({
        kind: "refine_item",
        payload: { item_id: item.id, user_id: userId, reason: "answer" },
      });
    }
    return { result: "ok", itemId: item.id };
  }

  async createCapture(userId: string, mediaCount: number): Promise<CaptureRecord> {
    const capture: CaptureRecord = {
      id: `00000000-0000-4000-8000-${String(this.#nextId++).padStart(12, "0")}`,
      userId,
      status: "uploading",
      mediaCount,
      itemCount: 0,
      progress: { stage: "uploading" },
      error: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
    };
    this.captures.push(capture);
    return capture;
  }

  async getCapture(userId: string, captureId: string): Promise<CaptureRecord | null> {
    return this.captures.find((c) => c.id === captureId && c.userId === userId) ?? null;
  }

  async submitCapture(
    userId: string,
    captureId: string,
    media: CaptureMediaInput[],
  ): Promise<CaptureRecord | null> {
    const capture = await this.getCapture(userId, captureId);
    if (!capture) return null;
    if (capture.status !== "uploading") throw new Error("capture already submitted");
    for (const m of media) this.captureMedia.push({ ...m, captureId });
    capture.status = "processing";
    capture.mediaCount = media.length;
    capture.progress = { stage: "detecting", detail: "Looking at your photos" };
    this.jobs.push({
      kind: "appraise_capture",
      payload: { capture_id: captureId, user_id: userId },
    });
    return capture;
  }

  async listCaptureItems(userId: string, captureId: string): Promise<ItemRecord[]> {
    return this.#shelf(userId)
      .filter((i) => i.captureId === captureId)
      .map((i) => this.#sync(i));
  }

  addAsk(ask: Partial<StoredAsk> & Pick<StoredAsk, "id" | "userId">): StoredAsk {
    const stored: StoredAsk = {
      rawText: "something",
      title: null,
      status: "drafting",
      target: null,
      offerItemIds: [],
      cashCeilingCents: 0,
      autonomy: "every_deal",
      deadline: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
      updatedAt: new Date("2026-10-03T00:00:00Z"),
      ...ask,
    };
    this.asks.push(stored);
    return stored;
  }

  addTasteFact(
    fact: Partial<TasteFactRecord> & Pick<TasteFactRecord, "id" | "userId">,
  ): TasteFactRecord {
    const stored: TasteFactRecord = {
      key: "interests",
      value: "LEGO",
      category: "interests",
      source: "chat",
      alwaysOn: false,
      status: "active",
      createdAt: new Date("2026-10-03T00:00:00Z"),
      ...fact,
    };
    this.tasteFacts.push(stored);
    return stored;
  }

  async listAsks(userId: string): Promise<AskRecord[]> {
    return this.asks
      .filter((a) => a.userId === userId && a.status !== "cancelled")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((a) => this.#askRecord(a));
  }

  async getAsk(userId: string, askId: string): Promise<AskRecord | null> {
    const ask = this.asks.find((a) => a.id === askId && a.userId === userId);
    return ask ? this.#askRecord(ask) : null;
  }

  async createAsk(userId: string, input: AskInsert): Promise<AskRecord> {
    const at = new Date("2026-10-03T00:00:00Z");
    // Later Asks sort first, as created_at does in the database.
    at.setTime(at.getTime() + this.asks.length * 1000);
    const ask = this.addAsk({
      id: randomUUID(),
      userId,
      ...input,
      deadline: null,
      createdAt: at,
      updatedAt: at,
    });
    return this.#askRecord(ask);
  }

  /** Mirrors public.patch_ask. */
  async updateAsk(userId: string, askId: string, update: AskUpdate): Promise<AskUpdateResult> {
    const ask = this.asks.find((a) => a.id === askId && a.userId === userId);
    if (!ask) return "not_found";
    if (CLOSED_ASK_STATUSES.includes(ask.status)) {
      const onlyCancel = Object.keys(update).every((k) => k === "cancel");
      return ask.status === "cancelled" && update.cancel && onlyCancel
        ? this.#askRecord(ask)
        : "ask_closed";
    }
    let status = ask.status;
    if (update.offerItemIds) {
      const ids = [...new Set(update.offerItemIds)];
      const valid = ids.every((id) =>
        this.items.some(
          (i) =>
            i.id === id &&
            i.ownerId === userId &&
            i.status === "on_shelf" &&
            i.reservedByDealId === null,
        ),
      );
      if (!valid) return "invalid_offer_item";
      ask.offerItemIds = ids;
      if (ids.length > 0 && (status === "drafting" || status === "offering"))
        status = "prospecting";
    }
    if (update.target !== undefined && status === "drafting") status = "offering";
    if (update.cancel) status = "cancelled";
    if (update.rawText !== undefined) ask.rawText = update.rawText;
    if (update.target !== undefined) ask.target = update.target;
    if (update.title !== undefined) ask.title = update.title;
    if (update.cashCeilingCents !== undefined) ask.cashCeilingCents = update.cashCeilingCents;
    if (update.autonomy !== undefined) ask.autonomy = update.autonomy;
    if (update.deadline !== undefined) ask.deadline = update.deadline;
    ask.status = status;
    return this.#askRecord(ask);
  }

  async listTasteFacts(userId: string): Promise<TasteFactRecord[]> {
    return this.tasteFacts
      .filter((f) => f.userId === userId && f.status === "active")
      .sort(
        (a, b) =>
          Number(b.alwaysOn) - Number(a.alwaysOn) || b.createdAt.getTime() - a.createdAt.getTime(),
      )
      .map((f) => ({ ...f }));
  }

  async deleteTasteFact(userId: string, factId: string): Promise<boolean> {
    const fact = this.tasteFacts.find((f) => f.id === factId && f.userId === userId);
    if (!fact) return false;
    fact.status = "deleted";
    return true;
  }

  async listCircles(userId: string): Promise<CircleRecord[]> {
    return this.memberships
      .filter((m) => m.userId === userId)
      .flatMap((m) => {
        const circle = this.#circleRecord(userId, m.circleId);
        return circle ? [circle] : [];
      });
  }

  async getCircle(userId: string, circleId: string) {
    const circle = this.#circleRecord(userId, circleId);
    if (!circle) return null;
    const members: CircleMemberRecord[] = this.memberships
      .filter((m) => m.circleId === circleId)
      .flatMap((m) => {
        const user = this.users.get(m.userId);
        if (!user || user.deletedAt) return [];
        return [
          {
            userId: m.userId,
            displayName: user.displayName,
            photoUrl: user.photoUrl,
            role: m.role ?? "member",
            joinedAt: m.joinedAt ?? new Date(0),
          },
        ];
      });
    // memberships is in join order already.
    return { ...circle, members };
  }

  async createCircle(userId: string, input: { name: string; categoryFocus: string[] }) {
    const id = randomUUID();
    const createdAt = new Date();
    this.circles.push({ id, ...input, status: "active", createdAt });
    this.memberships.push({ userId, circleId: id, role: "owner", joinedAt: createdAt });
    const circle = this.#circleRecord(userId, id);
    if (!circle) throw new Error("created Circle not found");
    return circle;
  }

  async createInvite(
    userId: string,
    circleId: string,
    input: { code: string; maxUses: number; expiresAt: Date },
  ): Promise<InviteRecord | null> {
    if (!this.#isMember(userId, circleId)) return null;
    const invite = { ...input, circleId, uses: 0, createdBy: userId };
    this.invites.push(invite);
    const { createdBy: _by, ...record } = invite;
    return record;
  }

  async previewInvite(userId: string, code: string, now: Date) {
    const invite = this.#openInvite(code);
    if (!invite) return null;
    const circle = this.circles.find((c) => c.id === invite.circleId);
    if (!circle) return null;
    const preview: InvitePreviewRecord = {
      code,
      circleName: circle.name,
      inviterName: this.users.get(invite.createdBy)?.displayName ?? null,
      memberCount: this.memberships.filter((m) => m.circleId === circle.id).length,
      status: this.#inviteStatus(userId, invite, now),
    };
    return preview;
  }

  /** Mirrors public.accept_invite. */
  async acceptInvite(userId: string, code: string, now: Date): Promise<AcceptInviteResult> {
    const invite = this.#openInvite(code);
    if (!invite) return "not_found";
    const status = this.#inviteStatus(userId, invite, now);
    if (status === "already_member") return { joined: false, circleId: invite.circleId };
    if (status !== "open") return status;
    this.memberships.push({ userId, circleId: invite.circleId, role: "member", joinedAt: now });
    invite.uses += 1;
    return { joined: true, circleId: invite.circleId };
  }

  #isMember(userId: string, circleId: string) {
    return this.memberships.some((m) => m.userId === userId && m.circleId === circleId);
  }

  #circleRecord(userId: string, circleId: string): CircleRecord | null {
    const circle = this.circles.find((c) => c.id === circleId);
    const mine = this.memberships.find((m) => m.userId === userId && m.circleId === circleId);
    if (!circle || !mine) return null;
    return {
      id: circle.id,
      name: circle.name,
      categoryFocus: [...circle.categoryFocus],
      role: mine.role ?? "member",
      memberCount: this.memberships.filter((m) => m.circleId === circleId).length,
      createdAt: circle.createdAt,
    };
  }

  #openInvite(code: string) {
    const invite = this.invites.find((i) => i.code === code);
    const circle = invite && this.circles.find((c) => c.id === invite.circleId);
    return invite && circle?.status === "active" ? invite : null;
  }

  #inviteStatus(userId: string, invite: InviteRecord, now: Date): InvitePreviewRecord["status"] {
    if (this.#isMember(userId, invite.circleId)) return "already_member";
    if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
    if (invite.uses >= invite.maxUses) return "full";
    return "open";
  }

  #askRecord(ask: StoredAsk): AskRecord {
    const { offerItemIds, ...rest } = ask;
    const offerItems = offerItemIds.flatMap((id) => {
      const item = this.items.find(
        (i) => i.id === id && i.ownerId === ask.userId && SHELF_STATUSES.includes(i.status),
      );
      return item
        ? [{ id, valueLowCents: item.valueLowCents, valueHighCents: item.valueHighCents }]
        : [];
    });
    return { ...rest, target: rest.target ? { ...rest.target } : null, offerItems };
  }

  /**
   * What the database derives: readiness (the items_readiness trigger) and the open
   * question summary (follow_up and open_questions).
   */
  #sync(item: ItemRecord): ItemRecord {
    const open = this.questions
      .filter((q) => q.itemId === item.id && q.status === "open")
      .sort(compareQuestions);
    item.openQuestions = open.length;
    item.followUp = open[0]?.prompt ?? null;
    item.readiness = computeReadiness({
      identityConf: item.identityConf,
      identityConfirmed: this.confirmed.has(item.id),
      valueLowCents: item.valueLowCents,
      valueHighCents: item.valueHighCents,
      photoScore: item.photoScore,
      missingAngles: item.missingAngles,
    });
    return item;
  }

  #shelf(userId: string): ItemRecord[] {
    return this.items.filter((i) => i.ownerId === userId && SHELF_STATUSES.includes(i.status));
  }
}
