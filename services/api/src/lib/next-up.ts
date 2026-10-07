import { type NextUpItem, offerFit } from "@throwin/shared";
import type {
  AskRecord,
  CircleRecord,
  DealRecord,
  ItemRecord,
  PhotoRequestRecord,
} from "../repo/types.js";

// Home's "Next up": what needs the user, best first, in the GM's voice. Ranked by what's
// at stake: a Deal that expires beats homework, and homework someone is waiting on beats
// homework nobody is. At most MAX_ITEMS, so it reads as a short list, never a backlog.

export const MAX_NEXT_UP = 6;

export interface NextUpInput {
  userId: string;
  now: Date;
  deals: DealRecord[];
  photoRequests: PhotoRequestRecord[];
  asks: AskRecord[];
  items: ItemRecord[];
  circles: CircleRecord[];
  /** Signed photo URLs by storage path. */
  urls: Map<string, string | null>;
}

const OPEN_ASK = new Set(["drafting", "offering", "prospecting", "proposed"]);

/** "Nintendo Switch OLED, white" reads as "Nintendo Switch OLED" in a sentence. */
const short = (title: string) => (title.split(",")[0] ?? title).trim();
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const range = (low: number, high: number) => `${dollars(low)} to ${dollars(high)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const hoursLeft = (until: Date, now: Date) =>
  Math.max(1, Math.round((until.getTime() - now.getTime()) / 3_600_000));
const askName = (a: AskRecord) => short(a.title ?? a.target?.name ?? a.rawText);

const blank = {
  deal_id: null,
  ask_id: null,
  item_id: null,
  angles: [] as string[],
  thumbnail_url: null,
  expires_at: null,
};

export function buildNextUp(input: NextUpInput): NextUpItem[] {
  const { userId, now, urls } = input;
  const out: NextUpItem[] = [];
  const photo = (path: string | null) => (path ? (urls.get(path) ?? null) : null);

  // 1. Deal Sheets waiting on this user's approval, soonest to expire first.
  const waiting = input.deals
    .filter(
      (d) =>
        d.status === "pending_approvals" &&
        d.participants.find((p) => p.userId === userId)?.approval === "pending",
    )
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  for (const d of waiting) {
    const get = d.legs.find((l) => l.receiverId === userId);
    const give = d.legs.find((l) => l.giverId === userId);
    if (!get || !give) continue;
    const from = d.participants.find((p) => p.userId === get.giverId)?.displayName;
    out.push({
      ...blank,
      id: `deal:${d.id}`,
      kind: "approve_deal",
      title: `${from ? `${from}'s ` : ""}${short(get.item.title)} for your ${short(give.item.title)}`,
      detail: `Waiting on you. Expires in ${plural(hoursLeft(d.expiresAt, now), "hour")}.`,
      cta: "Review",
      deal_id: d.id,
      thumbnail_url: photo(get.item.photoPath),
      expires_at: d.expiresAt.toISOString(),
    });
  }

  // 2. Someone's waiting on photos of the user's Item before a Deal can go out.
  for (const r of [...input.photoRequests].sort(
    (a, b) => a.expiresAt.getTime() - b.expiresAt.getTime(),
  )) {
    const angles = (r.missingAngles.length ? r.missingAngles : ["Front", "Back"]).slice(0, 5);
    out.push({
      ...blank,
      id: `photos:${r.dealId}:${r.itemId}`,
      kind: "showcase_photos",
      title: `${r.wantedBy ?? "Someone"} wants your ${short(r.itemTitle)}`,
      detail: `${plural(angles.length, "photo")} and the deal can go out. Held for ${plural(hoursLeft(r.expiresAt, now), "hour")}.`,
      cta: "Take photos",
      item_id: r.itemId,
      angles,
      thumbnail_url: photo(r.thumbnailPath),
      expires_at: r.expiresAt.toISOString(),
    });
  }

  const openAsks = input.asks.filter((a) => OPEN_ASK.has(a.status));
  const values = new Map(
    input.items.map((i) => [
      i.id,
      i.valueLowCents !== null && i.valueHighCents !== null
        ? { low: i.valueLowCents, high: i.valueHighCents, mid: i.valueMidCents }
        : null,
    ]),
  );

  // 3. Asks the GM can't work on until the user picks something to offer.
  for (const a of openAsks.filter((a) => a.target && a.offerItems.length === 0)) {
    out.push({
      ...blank,
      id: `offer:${a.id}`,
      kind: "offer_for_ask",
      title: `Pick what you'd give up for ${askName(a)}`,
      detail: "Your GM starts looking once you do.",
      cta: "Pick",
      ask_id: a.id,
      thumbnail_url: a.target?.image_url ?? null,
    });
  }

  // 4. Open Asks but nowhere to trade.
  if (openAsks.length > 0 && input.circles.length === 0) {
    out.push({
      ...blank,
      id: "circle",
      kind: "join_circle",
      title: "Join a Circle to start trading",
      detail: "Your GM only trades inside Circles. Ask a friend for an invite, or start one.",
      cta: "Circles",
    });
  }

  // 5. Offers that can't land as they stand.
  for (const a of openAsks) {
    const anchor = a.target?.anchor;
    if (!anchor || a.offerItems.length === 0) continue;
    const target = Math.round((anchor.used_low_cents + anchor.used_high_cents) / 2);
    const { verdict, bestId } = offerFit(
      target,
      a.offerItems.map((o) => ({ id: o.id, midCents: values.get(o.id)?.mid ?? null })),
      a.cashCeilingCents,
    );
    if (verdict.kind !== "short" || !bestId) continue;
    const best = values.get(bestId);
    const longShot = (best?.mid ?? 0) < target * 0.6;
    out.push({
      ...blank,
      id: `fit:${a.id}`,
      kind: "weak_offer",
      title: longShot
        ? `Your ${askName(a)} offer is a long shot`
        : `Your ${askName(a)} offer is a bit short`,
      detail:
        longShot && best
          ? `Your best is worth about ${range(best.low, best.high)}, and it goes for ${range(anchor.used_low_cents, anchor.used_high_cents)}.`
          : `About ${dollars(verdict.cents)} more cash, or something closer in value, would do it.`,
      cta: "Fix it",
      ask_id: a.id,
      thumbnail_url: a.target?.image_url ?? null,
    });
  }

  // 6. Tune up: the cheapest way to tighten the Shelf.
  const asking = input.items.filter((i) => i.openQuestions > 0 && !i.appraising);
  const questions = asking.reduce((n, i) => n + i.openQuestions, 0);
  if (questions > 0) {
    out.push({
      ...blank,
      id: "tune-up",
      kind: "tune_up",
      title: `Answer ${plural(questions, "quick question")}`,
      detail: `Pins down ${plural(asking.length, "item")} so your GM can price ${asking.length === 1 ? "it" : "them"}.`,
      cta: "Tune up",
    });
  }

  // 7. Identified Items a few photos from ready to show, most valuable first.
  const nearlyReady = input.items
    .filter((i) => i.readiness === "identified" && !i.appraising && i.status === "on_shelf")
    .sort((a, b) => (b.valueMidCents ?? 0) - (a.valueMidCents ?? 0))
    .slice(0, 2);
  for (const i of nearlyReady) {
    const angles = (i.missingAngles.length ? i.missingAngles : ["Front", "Back"]).slice(0, 5);
    out.push({
      ...blank,
      id: `ready:${i.id}`,
      kind: "item_photos",
      title: `${plural(angles.length, "photo")} and your ${short(i.title)} is ready to show`,
      detail: "Ready-to-show Items are the ones that land deals.",
      cta: "Take photos",
      item_id: i.id,
      angles,
      thumbnail_url: photo(i.thumbnailPath),
    });
  }

  // 8. Getting started.
  if (input.items.length === 0) {
    out.push({
      ...blank,
      id: "shelf",
      kind: "add_to_shelf",
      title: "Snap a few things you'd trade",
      detail: "Your GM names and prices each one in about 20 seconds.",
      cta: "Add",
    });
  }
  if (openAsks.length === 0) {
    out.push({
      ...blank,
      id: "ask",
      kind: "new_ask",
      title: "Tell your GM 1 thing you want",
      detail: "Every trade starts with a want.",
      cta: "New Ask",
    });
  }

  return out.slice(0, MAX_NEXT_UP);
}
