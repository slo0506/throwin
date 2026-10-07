import {
  type AskCardData,
  type NetworkItemCard,
  PhotoIssue,
  type ShelfItem,
  STUDIO_PHOTO_SCORE,
  sanitizeUntrusted,
} from "@throwin/shared";
import type { AskRecord, CircleStats, NetworkItem, OwnItem } from "./data.js";

/** "$180", or "$4.50" under $10. */
export function usd(cents: number): string {
  if (cents < 1000 && cents % 100 !== 0) return `$${(cents / 100).toFixed(2)}`;
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export const usdRange = (low: number, high: number) =>
  low === high ? `about ${usd(low)}` : `${usd(low)} to ${usd(high)}`;

/** Whole-dollar amounts as `usd` prints them, for the grounding check. */
export function dollarAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const whole = Number((m[1] ?? "0").replace(/,/g, ""));
    out.push(m[2] ? Math.round(whole + Number(m[2].padEnd(2, "0")) / 100) : whole);
  }
  return out;
}

/** Own text (the user's own words and titles): cleaned, not fenced. */
export const clean = (text: string, max = 200) =>
  sanitizeUntrusted(text, { maxLength: max }).replace(/\s+/g, " ").trim();

const PHOTO_ISSUES = new Set<string>(PhotoIssue.options);

export function toShelfItem(r: OwnItem, urls?: Map<string, string | null>): ShelfItem {
  const hasValue =
    r.valueLowCents !== null && r.valueMidCents !== null && r.valueHighCents !== null;
  const thumbnail = r.thumbnailPath ? (urls?.get(r.thumbnailPath) ?? null) : null;
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
    is_reserved: r.reserved,
    thumbnail_url: thumbnail,
    // Chat cards show 1 photo; the product page asks the API for the rest.
    photo_urls: thumbnail ? [thumbnail] : [],
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

export function toNetworkCard(r: NetworkItem, urls?: Map<string, string | null>): NetworkItemCard {
  const hasValue =
    r.valueLowCents !== null && r.valueMidCents !== null && r.valueHighCents !== null;
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    condition_grade: r.conditionGrade,
    value: hasValue
      ? {
          low_cents: r.valueLowCents as number,
          mid_cents: r.valueMidCents as number,
          high_cents: r.valueHighCents as number,
          currency: "USD",
        }
      : null,
    thumbnail_url: r.thumbnailPath ? (urls?.get(r.thumbnailPath) ?? null) : null,
    owner_first_name: r.ownerFirstName,
    readiness: r.readiness,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Plain words for an Ask card, computed by the server. */
export function statusLine(ask: AskRecord, stats: CircleStats): string {
  switch (ask.status) {
    case "drafting":
      return "Working out exactly what you want";
    case "offering":
      return "Waiting for what you'd offer";
    case "prospecting":
      if (stats.circles === 0) return "Waiting for you to join a Circle";
      if (stats.shelves === 0) return "Waiting for people to join your Circles";
      return `Checking ${plural(stats.shelves, "Shelf", "Shelves")} in ${plural(stats.circles, "Circle", "Circles")}`;
    case "proposed":
      return "A deal is ready for you to look at";
    case "accepted":
      return "Deal approved, setting up the handoff";
    case "fulfilled":
      return "Traded";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
  }
}

/** Sum of the offer Items' ranges. Null when no offered Item has a value yet. */
export function offerValue(items: OwnItem[]): { low_cents: number; high_cents: number } | null {
  const valued = items.filter((i) => i.valueLowCents !== null && i.valueHighCents !== null);
  if (valued.length === 0) return null;
  return {
    low_cents: valued.reduce((s, i) => s + (i.valueLowCents as number), 0),
    high_cents: valued.reduce((s, i) => s + (i.valueHighCents as number), 0),
  };
}

export const askTitle = (ask: AskRecord) => ask.title ?? ask.target?.name ?? null;

export function toAskCard(ask: AskRecord, offerItems: OwnItem[], stats: CircleStats): AskCardData {
  return {
    id: ask.id,
    raw_text: ask.rawText,
    title: askTitle(ask),
    status: ask.status,
    status_line: statusLine(ask, stats),
    target: ask.target,
    offer_item_ids: ask.offerItemIds,
    offer_value: offerValue(offerItems),
    cash_ceiling_cents: ask.cashCeilingCents,
    max_items: ask.maxItems,
    autonomy: ask.autonomy,
    deadline: ask.deadline?.toISOString() ?? null,
    created_at: ask.createdAt.toISOString(),
    updated_at: ask.updatedAt.toISOString(),
  };
}
