import type {
  AutonomyLevel,
  ConditionGrade,
  ItemStatus,
  ItemWillingness,
  NotificationPrefs,
} from "@throwin/shared";

/** A user row joined with its profile, in domain (camelCase) form. */
export interface MeRecord {
  id: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  autonomyLevel: AutonomyLevel;
  notificationPrefs: NotificationPrefs;
  homeArea: string | null;
  defaultHandoffPlaceId: string | null;
  counts: { shelfItems: number; activeAsks: number; circles: number };
}

export interface MePatch {
  displayName?: string;
  photoUrl?: string | null;
  autonomyLevel?: AutonomyLevel;
  /** Partial: merged into the stored prefs. */
  notificationPrefs?: Partial<NotificationPrefs>;
}

export interface ItemRecord {
  id: string;
  ownerId: string;
  status: ItemStatus;
  title: string;
  willingness: ItemWillingness;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  conditionGrade: ConditionGrade | null;
  defects: string[];
  valueLowCents: number | null;
  valueMidCents: number | null;
  valueHighCents: number | null;
  identityConf: number | null;
  conditionConf: number | null;
  reservedByDealId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Statuses shown on the Shelf. Removed and traded Items are history, not inventory. */
export const SHELF_STATUSES: readonly ItemStatus[] = [
  "draft",
  "needs_photos",
  "on_shelf",
  "reserved",
];
export const ACTIVE_ASK_STATUSES = ["drafting", "offering", "prospecting", "proposed", "accepted"];

/**
 * Data access for the API. Every method is scoped by the authenticated user's ID, because
 * the Supabase implementation uses the service role and bypasses RLS.
 */
export interface Repository {
  getMe(userId: string): Promise<MeRecord | null>;
  updateMe(userId: string, patch: MePatch): Promise<MeRecord | null>;
  /** Sets users.deleted_at if not already set and returns the stored value. */
  softDeleteUser(userId: string, at: Date): Promise<Date | null>;
  listShelfItems(userId: string): Promise<ItemRecord[]>;
}
