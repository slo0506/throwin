import type {
  ApprovalState,
  AskStatus,
  AskTarget,
  AutonomyLevel,
  CircleRole,
  ConditionGrade,
  DealStatus,
  ItemReadiness,
  ItemStatus,
  ItemWillingness,
  NotificationPrefs,
  QuestionKind,
  TasteFactCategory,
  TasteFactSource,
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
  /** The prompt of the Item's best open question, or null. */
  followUp: string | null;
  /** True while the Appraiser or Refiner is pricing or re-reading the Item. */
  appraising: boolean;
  /** Computed by the database on every write; never set by the API. */
  readiness: ItemReadiness;
  photoScore: number | null;
  photoIssues: string[];
  missingAngles: string[];
  description: string | null;
  openQuestions: number;
  captureId: string | null;
  /** Storage path of the Item's first photo or crop, if any. */
  thumbnailPath: string | null;
  /** Storage paths of every photo, the hero (position 0) first. */
  photoPaths: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemUpdate {
  title?: string;
  willingness?: ItemWillingness;
  conditionGrade?: ConditionGrade;
  /** The owner confirmed the product: pins identity, and moves draft to on_shelf. */
  confirm?: boolean;
}

/** An open Refiner question with what Tune up shows of its Item. */
export interface QuestionRecord {
  id: string;
  itemId: string;
  itemTitle: string;
  /** Storage path of the Item's first photo, if any. */
  thumbnailPath: string | null;
  kind: QuestionKind;
  prompt: string;
  options: string[];
  impact: number;
  createdAt: Date;
}

export type AnswerInput = { answer: string } | { skip: true };

export type AnswerResult =
  | { result: "ok"; itemId: string }
  | { result: "not_found" | "already_answered" | "item_reserved" | "use_media_upload" }
  | { result: "invalid_answer" };

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

/** An Item in an Ask's offer set, with what its value range adds to the offer. */
export interface OfferItemRecord {
  id: string;
  valueLowCents: number | null;
  valueHighCents: number | null;
}

export interface AskRecord {
  id: string;
  userId: string;
  rawText: string;
  title: string | null;
  status: AskStatus;
  /** Null until resolved. Stored as jsonb in the wire shape. */
  target: AskTarget | null;
  /** Offer Items still on the Shelf or held by a Deal (removed and traded ones drop out). */
  offerItems: OfferItemRecord[];
  /** Private to the owner. Never leaves through network reads. */
  cashCeilingCents: number;
  /** How many Items the Ask takes (bundles). */
  maxItems: number;
  autonomy: AutonomyLevel;
  deadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AskInsert {
  rawText: string;
  target: AskTarget | null;
  title: string | null;
  status: AskStatus;
  cashCeilingCents: number;
  maxItems: number;
  autonomy: AutonomyLevel;
}

/** Only the fields present change. A null deadline clears it. */
export interface AskUpdate {
  rawText?: string;
  target?: AskTarget;
  title?: string | null;
  offerItemIds?: string[];
  cashCeilingCents?: number;
  maxItems?: number;
  autonomy?: AutonomyLevel;
  deadline?: Date | null;
  cancel?: true;
}

export type AskUpdateResult = AskRecord | "not_found" | "invalid_offer_item" | "ask_closed";

export interface TasteFactRecord {
  id: string;
  userId: string;
  key: string;
  value: string;
  category: TasteFactCategory;
  source: TasteFactSource;
  alwaysOn: boolean;
  status: "active" | "superseded" | "deleted";
  createdAt: Date;
}

export interface CircleRecord {
  id: string;
  name: string;
  categoryFocus: string[];
  /** The caller's role. */
  role: CircleRole;
  memberCount: number;
  createdAt: Date;
}

export interface CircleMemberRecord {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
  role: CircleRole;
  joinedAt: Date;
}

export interface InviteRecord {
  code: string;
  circleId: string;
  maxUses: number;
  uses: number;
  expiresAt: Date;
}

export interface InvitePreviewRecord {
  code: string;
  circleName: string;
  inviterName: string | null;
  memberCount: number;
  status: "open" | "expired" | "full" | "already_member";
}

/** public.accept_invite's results. Joining or already being in it both return the Circle. */
export type AcceptInviteResult =
  | { joined: boolean; circleId: string }
  | "not_found"
  | "expired"
  | "full";

export interface DealPersonRecord {
  userId: string;
  displayName: string | null;
  photoUrl: string | null;
}

export interface DealItemRecord {
  id: string;
  title: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  conditionGrade: ConditionGrade | null;
  valueLowCents: number | null;
  valueMidCents: number | null;
  valueHighCents: number | null;
  /** The Item's first photo, to sign for the response. */
  photoPath: string | null;
}

/** A Deal as every participant sees it; the route turns it into 1 person's Deal Sheet. */
export interface DealRecord {
  id: string;
  status: DealStatus;
  expiresAt: Date;
  /**
   * `askId` is the receiver's Ask the leg fills, when it fills 1. `giverAskId` is the giver's
   * Ask whose offer set held the Item (the 1 the Deal fills for the giver); null on legs
   * staged before bundles.
   */
  legs: {
    giverId: string;
    receiverId: string;
    askId: string | null;
    giverAskId: string | null;
    item: DealItemRecord;
  }[];
  throwIns: { payerId: string; payeeId: string; amountCents: number }[];
  participants: (DealPersonRecord & { approval: ApprovalState; why: string | null })[];
}

/**
 * A staged Deal waiting for showcase photos of 1 of the user's Items (PRD "Demand-driven
 * homework"): the Deal can't go out until every Item in it is ready to show.
 */
export interface PhotoRequestRecord {
  dealId: string;
  expiresAt: Date;
  itemId: string;
  itemTitle: string;
  missingAngles: string[];
  thumbnailPath: string | null;
  /** First name of the person the Item would go to. */
  wantedBy: string | null;
}

/** public.approve_deal and public.decline_deal results; on success, the Deal afterwards. */
export type DealDecisionResult = DealRecord | "not_found" | "closed" | "decided";

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

  /** The user's open questions on Shelf Items, optionally for 1 Item, in any order. */
  listOpenQuestions(userId: string, itemId?: string): Promise<QuestionRecord[]>;
  /**
   * Answers or skips the user's open question, marks its Item appraising and queues a
   * Refiner pass, all at once. Checks the answer against the question's kind and options.
   */
  answerQuestion(userId: string, questionId: string, input: AnswerInput): Promise<AnswerResult>;

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

  /** The user's Asks, newest first, without cancelled ones. */
  listAsks(userId: string): Promise<AskRecord[]>;
  /** Null when missing or someone else's. */
  getAsk(userId: string, askId: string): Promise<AskRecord | null>;
  createAsk(userId: string, input: AskInsert): Promise<AskRecord>;
  /**
   * Applies an owner's edit atomically (public.patch_ask). Offer Items must be the owner's,
   * on the Shelf and not reserved; a non-empty offer set moves a drafting or offering Ask to
   * prospecting, and a target moves a drafting Ask to offering.
   */
  updateAsk(userId: string, askId: string, update: AskUpdate): Promise<AskUpdateResult>;

  /** Active facts only: always-on first, then newest. */
  listTasteFacts(userId: string): Promise<TasteFactRecord[]>;
  /** Marks the user's fact deleted. False when missing or someone else's. */
  deleteTasteFact(userId: string, factId: string): Promise<boolean>;

  /** Circles the user belongs to, oldest membership first. */
  listCircles(userId: string): Promise<CircleRecord[]>;
  /** Null unless the user is a member, so Circle IDs cannot be probed. */
  getCircle(
    userId: string,
    circleId: string,
  ): Promise<(CircleRecord & { members: CircleMemberRecord[] }) | null>;
  /** The creator becomes its owner and first member. */
  createCircle(
    userId: string,
    input: { name: string; categoryFocus: string[] },
  ): Promise<CircleRecord>;
  /** Null unless the user is a member of the Circle. */
  createInvite(
    userId: string,
    circleId: string,
    input: { code: string; maxUses: number; expiresAt: Date },
  ): Promise<InviteRecord | null>;
  /** Null when the code doesn't exist or its Circle is paused. */
  previewInvite(userId: string, code: string, now: Date): Promise<InvitePreviewRecord | null>;
  /** Atomic (public.accept_invite): a use is counted only when the user actually joins. */
  acceptInvite(userId: string, code: string, now: Date): Promise<AcceptInviteResult>;

  /** Deals awaiting approval or approved that the user is in, newest first. */
  listDeals(userId: string): Promise<DealRecord[]>;
  /** Null unless the user is in it. Staged Deals are never shown, so they are null too. */
  getDeal(userId: string, dealId: string): Promise<DealRecord | null>;
  /** Staged Deals waiting on showcase photos of the user's own Items. */
  listPhotoRequests(userId: string): Promise<PhotoRequestRecord[]>;
  /** public.approve_deal, with the Deal Sheet the user saw as the snapshot. */
  approveDeal(userId: string, dealId: string, snapshot: unknown): Promise<DealDecisionResult>;
  /** public.decline_deal. */
  declineDeal(userId: string, dealId: string, reason: string | null): Promise<DealDecisionResult>;
}
