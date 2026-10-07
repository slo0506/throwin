import type Anthropic from "@anthropic-ai/sdk";
import type {
  AskCardTarget,
  AskStatus,
  AutonomyLevel,
  ConditionGrade,
  ItemReadiness,
  ItemStatus,
  ItemWillingness,
} from "@throwin/shared";

// Everything the GM reads and writes, in domain (camelCase) form. Every method takes the
// acting user's ID and scopes by it, because the Supabase implementation uses the service
// role and bypasses row-level security.

/** Statuses shown on the Shelf. Removed and traded Items are history, not inventory. */
export const SHELF_STATUSES: readonly ItemStatus[] = [
  "draft",
  "needs_photos",
  "on_shelf",
  "reserved",
];
export const ACTIVE_ASK_STATUSES: readonly AskStatus[] = [
  "drafting",
  "offering",
  "prospecting",
  "proposed",
  "accepted",
];

export interface GmUser {
  id: string;
  firstName: string | null;
  autonomy: AutonomyLevel;
}

/** 1 of the user's own Items. */
export interface OwnItem {
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
  reserved: boolean;
  appraising: boolean;
  readiness: ItemReadiness;
  photoScore: number | null;
  photoIssues: string[];
  missingAngles: string[];
  description: string | null;
  openQuestions: number;
  followUp: string | null;
  thumbnailPath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Another Circle member's Item, with only the fields that are safe to share. Only
 * `on_shelf`, `showcase`, tradeable Items of members who share a Circle with the user and
 * have not blocked them (or been blocked) ever come back.
 */
export interface NetworkItem {
  id: string;
  ownerId: string;
  /** Written by the owner: untrusted. */
  ownerFirstName: string;
  /** Written by the owner: untrusted. */
  title: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  conditionGrade: ConditionGrade | null;
  valueLowCents: number | null;
  valueMidCents: number | null;
  valueHighCents: number | null;
  readiness: ItemReadiness;
  /** Written from the owner's photos and answers: untrusted. */
  description: string | null;
  thumbnailPath: string | null;
}

export interface NetworkQuery {
  /** Plain words. Implementations strip anything but letters, digits and spaces. */
  query?: string | undefined;
  ids?: string[] | undefined;
  limit: number;
}

export type AskTarget = AskCardTarget;

export interface AskRecord {
  id: string;
  userId: string;
  rawText: string;
  title: string | null;
  status: AskStatus;
  target: AskTarget | null;
  cashCeilingCents: number;
  deadline: Date | null;
  autonomy: AutonomyLevel;
  offerItemIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAsk {
  rawText: string;
  title: string | null;
  target: AskTarget | null;
  status: AskStatus;
  autonomy: AutonomyLevel;
  deadline: Date | null;
}

/**
 * An owner's edit, applied by public.patch_ask in 1 transaction. Status moves only by its
 * rules: a target moves drafting to offering, a non-empty offer set moves drafting or
 * offering to prospecting.
 */
export interface AskPatch {
  rawText?: string;
  title?: string | null;
  target?: AskTarget | null;
  /** Replaces the offer set. Items must be the owner's, on the Shelf and not reserved. */
  offerItemIds?: string[];
  cashCeilingCents?: number;
  autonomy?: AutonomyLevel;
  deadline?: Date | null;
}

export type AskUpdateResult = AskRecord | "not_found" | "ask_closed" | "invalid_offer_item";

export interface TasteFact {
  id: string;
  key: string;
  value: string;
  category: string;
}

export interface CircleStats {
  circles: number;
  /** Other members' Shelves the Prospector can check. */
  shelves: number;
}

export interface Conversation {
  id: string;
  userId: string;
  createdAt: Date;
}

/** A row of `messages`: API-native content blocks plus the server's record of the turn. */
export interface StoredMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: "user" | "assistant";
  content: Anthropic.ContentBlockParam[];
  toolCalls: unknown;
  createdAt: Date;
}

export interface AgentRun {
  id: string;
  userId: string;
  askId: string | null;
  agent: string;
  trigger: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCents: number;
  latencyMs: number;
  outcome: string;
}

export interface AgentEvent {
  runId: string;
  userId: string;
  type: string;
  userVisible: boolean;
  summary: string | null;
  payload: Record<string, unknown>;
}

export interface LoadedImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
}

export interface GmData {
  getUser(userId: string): Promise<GmUser | null>;

  /** The user's Shelf (draft, on_shelf and reserved Items), newest first. */
  listShelfItems(userId: string): Promise<OwnItem[]>;
  /** The user's own Items among `ids`, any Shelf status. Missing IDs are skipped. */
  getOwnItems(userId: string, ids: string[]): Promise<OwnItem[]>;
  /** Willingness only. Null when the Item is not on the user's Shelf. */
  setItemWillingness(
    userId: string,
    itemId: string,
    willingness: ItemWillingness,
  ): Promise<OwnItem | null>;

  listNetworkItems(userId: string, query: NetworkQuery): Promise<NetworkItem[]>;
  circleStats(userId: string): Promise<CircleStats>;

  listActiveAsks(userId: string): Promise<AskRecord[]>;
  getAsk(userId: string, askId: string): Promise<AskRecord | null>;
  createAsk(userId: string, ask: NewAsk): Promise<AskRecord>;
  /** The same write path as PATCH /v1/asks/{id}: public.patch_ask. */
  updateAsk(userId: string, askId: string, patch: AskPatch): Promise<AskUpdateResult>;

  /**
   * Which deals to bring the user, for every Ask: the profile setting, copied onto their
   * open Asks so the 2 never disagree.
   */
  setAutonomy(userId: string, level: AutonomyLevel): Promise<void>;

  /** Active, always-on taste facts. Written only by the memory extractor. */
  listAlwaysOnFacts(userId: string): Promise<TasteFact[]>;

  latestConversation(userId: string): Promise<Conversation | null>;
  createConversation(userId: string): Promise<Conversation>;
  /** The newest `limit` messages of the conversation, oldest first. */
  listMessages(userId: string, conversationId: string, limit: number): Promise<StoredMessage[]>;
  /** Inserts rows with caller-chosen IDs and timestamps, in 1 statement. */
  appendMessages(rows: StoredMessage[]): Promise<void>;
  /** True once a `finish_intake` call succeeded in this conversation. */
  intakeFinished(userId: string, conversationId: string): Promise<boolean>;

  recordRun(run: AgentRun): Promise<void>;
  recordEvents(events: AgentEvent[]): Promise<void>;
  enqueueJob(kind: string, payload: Record<string, unknown>): Promise<void>;

  /** Signed read URLs (1 hour). Missing paths map to null. */
  signedUrls(paths: string[]): Promise<Map<string, string | null>>;
  /** A photo the user uploaded, for `resolve_target`. Null unless the path is the user's. */
  loadImage(userId: string, path: string): Promise<LoadedImage | null>;
}
