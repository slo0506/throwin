import {
  compareQuestions,
  computeReadiness,
  DEFAULT_NOTIFICATION_PREFS,
  type QuestionKind,
  type QuestionStatus,
} from "@throwin/shared";
import {
  ACTIVE_ASK_STATUSES,
  type AnswerInput,
  type AnswerResult,
  type CaptureMediaInput,
  type CaptureRecord,
  type ItemRecord,
  type ItemUpdate,
  type MePatch,
  type MeRecord,
  type QuestionRecord,
  type Repository,
  SHELF_STATUSES,
} from "./types.js";

type StoredUser = Omit<MeRecord, "counts">;

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
  readonly asks: { userId: string; status: string }[] = [];
  readonly memberships: { userId: string; circleId: string }[] = [];
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
