import { DEFAULT_NOTIFICATION_PREFS } from "@throwin/shared";
import {
  ACTIVE_ASK_STATUSES,
  type CaptureMediaInput,
  type CaptureRecord,
  type ItemRecord,
  type ItemUpdate,
  type MePatch,
  type MeRecord,
  type Repository,
  SHELF_STATUSES,
} from "./types.js";

type StoredUser = Omit<MeRecord, "counts">;

/** In-memory repository for tests and local experiments. */
export class MemoryRepository implements Repository {
  readonly users = new Map<string, StoredUser>();
  readonly items: ItemRecord[] = [];
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
      captureId: null,
      thumbnailPath: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
      updatedAt: new Date("2026-10-03T00:00:00Z"),
      ...item,
    };
    this.items.push(record);
    return record;
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
    return this.#shelf(userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async updateItem(userId: string, itemId: string, update: ItemUpdate): Promise<ItemRecord | null> {
    const item = this.#shelf(userId).find((i) => i.id === itemId);
    if (!item) return null;
    if (update.title !== undefined) item.title = update.title;
    if (update.willingness !== undefined) item.willingness = update.willingness;
    if (update.conditionGrade !== undefined) item.conditionGrade = update.conditionGrade;
    if (update.confirm && (item.status === "draft" || item.status === "needs_photos")) {
      item.status = "on_shelf";
      item.followUp = null;
    }
    return item;
  }

  async getItem(userId: string, itemId: string): Promise<ItemRecord | null> {
    return (
      this.items.find((i) => i.id === itemId && i.ownerId === userId && i.status !== "removed") ??
      null
    );
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
    item.appraising = true;
    this.jobs.push({ kind: "reappraise_item", payload: { item_id: itemId, user_id: userId } });
    return item;
  }

  async removeItem(userId: string, itemId: string): Promise<"removed" | "not_found" | "reserved"> {
    const item = this.#shelf(userId).find((i) => i.id === itemId);
    if (!item) return "not_found";
    if (item.reservedByDealId) return "reserved";
    item.status = "removed";
    return "removed";
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
    return this.#shelf(userId).filter((i) => i.captureId === captureId);
  }

  #shelf(userId: string): ItemRecord[] {
    return this.items.filter((i) => i.ownerId === userId && SHELF_STATUSES.includes(i.status));
  }
}
