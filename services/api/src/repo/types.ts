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
  followUp: string | null;
  /** True while the Appraiser is pricing or re-reading the Item. */
  appraising: boolean;
  captureId: string | null;
  /** Storage path of the Item's first photo or crop, if any. */
  thumbnailPath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemUpdate {
  title?: string;
  willingness?: ItemWillingness;
  conditionGrade?: ConditionGrade;
  /** Promote draft or needs_photos to on_shelf. */
  confirm?: boolean;
}

export type CaptureStatus = "uploading" | "processing" | "done" | "failed";

export interface CaptureRecord {
  id: string;
  userId: string;
  status: CaptureStatus;
  mediaCount: number;
  itemCount: number;
  progress: { stage?: string; detail?: string; found?: number };
  error: string | null;
  createdAt: Date;
}

export interface CaptureMediaInput {
  path: string;
  width?: number | undefined;
  height?: number | undefined;
  sharpness?: number | undefined;
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
  /** Returns null when the Item does not exist or belongs to someone else. */
  updateItem(userId: string, itemId: string, update: ItemUpdate): Promise<ItemRecord | null>;
  /** Any of the user's Items except removed ones. Null when missing or someone else's. */
  getItem(userId: string, itemId: string): Promise<ItemRecord | null>;
  /**
   * Records follow-up photos, marks the Item appraising and enqueues the Appraiser, all at
   * once. "conflict" when a Deal holds the Item or it is already being appraised.
   */
  submitItemMedia(
    userId: string,
    itemId: string,
    media: CaptureMediaInput[],
  ): Promise<ItemRecord | "not_found" | "conflict">;
  /** Marks the Item removed. False when missing, not the user's, or reserved by a Deal. */
  removeItem(userId: string, itemId: string): Promise<"removed" | "not_found" | "reserved">;

  createCapture(
    userId: string,
    mediaCount: number,
    kind: "photo" | "frame",
  ): Promise<CaptureRecord>;
  getCapture(userId: string, captureId: string): Promise<CaptureRecord | null>;
  /** Records uploaded media, moves the capture to processing and enqueues the Appraiser. */
  submitCapture(
    userId: string,
    captureId: string,
    media: CaptureMediaInput[],
  ): Promise<CaptureRecord | null>;
  listCaptureItems(userId: string, captureId: string): Promise<ItemRecord[]>;
}
