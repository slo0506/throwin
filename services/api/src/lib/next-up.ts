import { type NextUpItem, offerFit } from "@throwin/shared";
import type {
  AskRecord,
  CircleRecord,
  DealRecord,
  DemandRecord,
  InquiryRecord,
  InterestRecord,
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
  /** What people in the user's Circles want, as counts (circle_demand). */
  demand: DemandRecord[];
  /** The Liaison's open questions to the user. */
  inquiries: InquiryRecord[];
  /** Circle-mates who want an Item the user offers for nothing. */
  interests: InterestRecord[];
  /** Signed photo URLs by storage path. */
  urls: Map<string, string | null>;
}

const OPEN_ASK = new Set(["drafting", "offering", "prospecting", "proposed"]);

/** "Nintendo Switch OLED, white" reads as "Nintendo Switch OLED" in a sentence. */
const short = (title: string) => (title.split(",")[0] ?? title).trim();
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const range = (low: number, high: number) => `${dollars(low)} to ${dollars(high)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Zelda", or "Zelda and 2 more" for a bundle. */
const side = (legs: { item: { title: string } }[]) =>
  `${short(legs[0]?.item.title ?? "")}${legs.length > 1 ? ` and ${legs.length - 1} more` : ""}`;
const hoursLeft = (until: Date, now: Date) =>
  Math.max(1, Math.round((until.getTime() - now.getTime()) / 3_600_000));
const askName = (a: AskRecord) => short(a.title ?? a.target?.name ?? a.rawText);

/** "Maya asked for your Zelda too": the first change in an open counter, from the user's side. */
function counterTitle(d: DealRecord, userId: string, from: string): string {
  const counter = d.counter;
  const first = counter?.changes[0];
  if (!counter || !first) return `${from} wants to change your trade`;
  const leg = (first.op === "remove" ? d.legs : counter.legs).find(
    (l) => l.item.id === first.item_id,
  );
  if (!leg) return `${from} wants to change your trade`;
  const title = short(leg.item.title);
  const more = counter.changes.length > 1 ? ", and more" : "";
  if (first.op === "add") {
    return leg.giverId === userId
      ? `${from} asked for your ${title} too${more}`
      : `${from} offered their ${title} too${more}`;
  }
  return leg.giverId === userId
    ? `${from} asked to leave out your ${title}${more}`
    : `${from} wants to keep their ${title}${more}`;
}

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

  // 1. Counters waiting on this user's answer, soonest to expire first. Nobody can approve
  //    while 1 is open, so their Deal Sheets wait too.
  const countered = input.deals
    .filter(
      (d) =>
        d.status === "pending_approvals" &&
        d.counter?.awaiting.includes(userId) &&
        !d.counter.answers[userId],
    )
    .sort((a, b) => (a.counter?.expiresAt.getTime() ?? 0) - (b.counter?.expiresAt.getTime() ?? 0));
  for (const d of countered) {
    const counter = d.counter;
    if (!counter) continue;
    const from = d.participants.find((p) => p.userId === counter.proposedBy)?.displayName;
    out.push({
      ...blank,
      id: `counter:${counter.id}`,
      kind: "answer_counter",
      title: counterTitle(d, userId, from ?? "Someone"),
      detail: `Waiting on your answer. Open for ${plural(hoursLeft(counter.expiresAt, now), "hour")}.`,
      cta: "Review",
      deal_id: d.id,
      expires_at: counter.expiresAt.toISOString(),
    });
  }

  // 2. Deal Sheets waiting on this user's approval, soonest to expire first.
  const waiting = input.deals
    .filter(
      (d) =>
        d.status === "pending_approvals" &&
        !d.counter &&
        d.participants.find((p) => p.userId === userId)?.approval === "pending",
    )
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  for (const d of waiting) {
    const gets = d.legs.filter((l) => l.receiverId === userId);
    const gives = d.legs.filter((l) => l.giverId === userId);
    const [get] = gets;
    if (!get || gives.length === 0) continue;
    const from = d.participants.find((p) => p.userId === get.giverId)?.displayName;
    out.push({
      ...blank,
      id: `deal:${d.id}`,
      kind: "approve_deal",
      title: `${from ? `${from}'s ` : ""}${side(gets)} for your ${side(gives)}`,
      detail: `Waiting on you. Expires in ${plural(hoursLeft(d.expiresAt, now), "hour")}.`,
      cta: "Review",
      deal_id: d.id,
      thumbnail_url: photo(get.item.photoPath),
      expires_at: d.expiresAt.toISOString(),
    });
  }

  // 3. Someone's waiting on the user's Item before a Deal can go out: the GM can't tell
  //    what it is yet. Quick answers settle that cheapest; photos when there's nothing to ask.
  for (const r of [...input.photoRequests].sort(
    (a, b) => a.expiresAt.getTime() - b.expiresAt.getTime(),
  )) {
    if (r.openQuestions > 0) {
      out.push({
        ...blank,
        id: `pin:${r.dealId}:${r.itemId}`,
        kind: "pin_down_item",
        title: `${r.wantedBy ?? "Someone"} wants your ${short(r.itemTitle)}`,
        detail: `${plural(r.openQuestions, "quick answer")} and the deal can go out. Held for ${plural(hoursLeft(r.expiresAt, now), "hour")}.`,
        cta: "Answer",
        item_id: r.itemId,
        thumbnail_url: photo(r.thumbnailPath),
        expires_at: r.expiresAt.toISOString(),
      });
      continue;
    }
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

  // 4. The Liaison's questions: 1 tap decides whether a guess becomes a want.
  for (const q of input.inquiries) {
    out.push({
      ...blank,
      id: `inquiry:${q.id}`,
      kind: "answer_inquiry",
      title: `Would ${short(q.item.title)} work for your ${short(q.askTitle)}?`,
      detail: `Someone in your Circles could trade it to you. Open for ${plural(hoursLeft(q.expiresAt, now), "hour")}.`,
      cta: "Answer",
      ask_id: q.askId,
      item_id: q.item.id,
      thumbnail_url: photo(q.item.photoPath),
      expires_at: q.expiresAt.toISOString(),
    });
  }

  // 4b. Someone wants an Item the user offers for nothing: see what they'd trade.
  for (const n of input.interests) {
    const who = n.wanterFirstName ?? "Someone in your Circles";
    out.push({
      ...blank,
      id: `interest:${n.id}`,
      kind: "someone_wants",
      title: `${who} is looking for your ${short(n.item.title)}`,
      detail: `See what ${n.wanterFirstName ?? "they"} would trade. Open for ${plural(hoursLeft(n.expiresAt, now), "hour")}.`,
      cta: "See trade",
      item_id: n.item.id,
      thumbnail_url: photo(n.item.photoPath),
      expires_at: n.expiresAt.toISOString(),
    });
  }

  // 5. Asks the GM can't work on until the user picks something to offer.
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

  // 6. Open Asks but nowhere to trade.
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

  // 7. Offers that can't land as they stand.
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

  // 8. Something people want that 1 of the user's Items could fill, and that Item isn't
  //    offered for anything yet: a reason to trade it. Counts only, never who.
  const offered = new Set(openAsks.flatMap((a) => a.offerItems.map((i) => i.id)));
  const shelf = new Map(input.items.map((i) => [i.id, i]));
  for (const want of input.demand) {
    const item = want.itemIds.map((id) => shelf.get(id)).find((i) => i && !offered.has(i.id));
    if (!item) continue;
    out.push({
      ...blank,
      id: `demand:${want.label.toLowerCase()}`,
      kind: "in_demand",
      title: `Wanted in your Circles: ${short(want.label)}`,
      detail: `${want.askers === 1 ? "Someone is" : `${want.askers} people are`} looking, and your ${short(item.title)} could fill it.`,
      cta: "Trade it",
      item_id: item.id,
      thumbnail_url: photo(item.thumbnailPath),
    });
    break;
  }

  // 9. Tune up: the cheapest way to tighten the Shelf.
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

  // 10. Identified Items a few photos from ready to show, most valuable first.
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

  // 11. Getting started.
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
