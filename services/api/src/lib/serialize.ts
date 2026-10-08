import {
  type Ask,
  askStatusLine,
  type Capture,
  type Me,
  PhotoIssue,
  type Question,
  type ShelfItem,
  STUDIO_PHOTO_SCORE,
  TASTE_FACT_SOURCE_LABELS,
  type TasteFact,
} from "@throwin/shared";
import type {
  AskRecord,
  CaptureRecord,
  ItemRecord,
  MeRecord,
  QuestionRecord,
  TasteFactRecord,
} from "../repo/types.js";

/**
 * The owner's view of an Ask. It carries cash_ceiling_cents, so only routes that already
 * checked the caller owns the Ask may use it; network reads need their own shape.
 */
export function toOwnAsk(r: AskRecord): Ask {
  // Unpriced Items add nothing until the Appraiser prices them.
  const offerValue = r.offerItems.reduce(
    (sum, i) => ({
      low_cents: sum.low_cents + (i.valueLowCents ?? 0),
      high_cents: sum.high_cents + (i.valueHighCents ?? 0),
    }),
    { low_cents: 0, high_cents: 0 },
  );
  return {
    id: r.id,
    raw_text: r.rawText,
    title: r.title,
    status: r.status,
    status_line: askStatusLine(r.status, r.offerItems.length),
    target: r.target,
    offer_item_ids: r.offerItems.map((i) => i.id),
    offer_value: offerValue,
    cash_ceiling_cents: r.cashCeilingCents,
    max_items: r.maxItems,
    autonomy: r.autonomy,
    deadline: r.deadline ? r.deadline.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export function toTasteFact(r: TasteFactRecord): TasteFact {
  return {
    id: r.id,
    key: r.key,
    value: r.value,
    category: r.category,
    source: TASTE_FACT_SOURCE_LABELS[r.source],
    always_on: r.alwaysOn,
    created_at: r.createdAt.toISOString(),
  };
}

export function toMe(r: MeRecord): Me {
  return {
    id: r.id,
    display_name: r.displayName,
    photo_url: r.photoUrl,
    created_at: r.createdAt.toISOString(),
    profile: {
      autonomy_level: r.autonomyLevel,
      notification_prefs: r.notificationPrefs,
      home_area: r.homeArea,
      default_handoff_place_id: r.defaultHandoffPlaceId,
    },
    counts: {
      shelf_items: r.counts.shelfItems,
      active_asks: r.counts.activeAsks,
      circles: r.counts.circles,
    },
  };
}

export function toShelfItem(r: ItemRecord, urls?: Map<string, string | null>): ShelfItem {
  const hasValue =
    r.valueLowCents !== null && r.valueMidCents !== null && r.valueHighCents !== null;
  return {
    id: r.id,
    status: r.status,
    title: r.title,
    willingness: r.willingness,
    category: r.category,
    brand: r.brand,
    model: r.model,
    variant: r.variant,
    condition_grade: r.conditionGrade,
    defects: r.defects,
    value: hasValue
      ? {
          low_cents: r.valueLowCents as number,
          mid_cents: r.valueMidCents as number,
          high_cents: r.valueHighCents as number,
          currency: "USD",
        }
      : null,
    identity_confidence: r.identityConf,
    condition_confidence: r.conditionConf,
    is_reserved: r.reservedByDealId !== null,
    thumbnail_url: r.thumbnailPath ? (urls?.get(r.thumbnailPath) ?? null) : null,
    photo_urls: r.photoPaths.flatMap((p) => {
      const url = urls?.get(p);
      return url ? [url] : [];
    }),
    follow_up: r.followUp,
    is_appraising: r.appraising,
    readiness: r.readiness,
    photo_score: r.photoScore,
    photo_issues: r.photoIssues.filter((i): i is PhotoIssue => PHOTO_ISSUES.has(i)),
    missing_angles: r.missingAngles,
    studio_allowed: r.photoScore !== null && r.photoScore >= STUDIO_PHOTO_SCORE,
    description: r.description,
    open_questions: r.openQuestions,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

const PHOTO_ISSUES = new Set<string>(PhotoIssue.options);

export function toQuestion(r: QuestionRecord, urls?: Map<string, string | null>): Question {
  return {
    id: r.id,
    item_id: r.itemId,
    item_title: r.itemTitle,
    thumbnail_url: r.thumbnailPath ? (urls?.get(r.thumbnailPath) ?? null) : null,
    kind: r.kind,
    prompt: r.prompt,
    options: r.options,
    created_at: r.createdAt.toISOString(),
  };
}

export function toCapture(
  r: CaptureRecord,
  items: ItemRecord[],
  urls?: Map<string, string | null>,
): Capture {
  return {
    id: r.id,
    status: r.status,
    media_count: r.mediaCount,
    item_count: r.itemCount,
    progress: r.progress as Capture["progress"],
    error: r.error,
    items: items.map((i) => toShelfItem(i, urls)),
    created_at: r.createdAt.toISOString(),
  };
}
