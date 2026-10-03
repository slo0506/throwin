import { DEFAULT_NOTIFICATION_PREFS } from "@throwin/shared";
import {
  ACTIVE_ASK_STATUSES,
  type ItemRecord,
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

  #shelf(userId: string): ItemRecord[] {
    return this.items.filter((i) => i.ownerId === userId && SHELF_STATUSES.includes(i.status));
  }
}
