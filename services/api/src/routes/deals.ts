import {
  DealDecline,
  type DealItem,
  type DealPerson,
  type DealSheet,
  type DealSheetsResponse,
} from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../lib/body.js";
import { HttpError } from "../lib/errors.js";
import type { MediaStore } from "../repo/media.js";
import type { DealDecisionResult, DealItemRecord, DealRecord, Repository } from "../repo/types.js";
import type { AppEnv } from "../types.js";

const isUuid = (id: string) => z.uuid().safeParse(id).success;
const notFound = () => new HttpError(404, "not_found", "That Deal isn't yours or doesn't exist");

/** Builds 1 participant's Deal Sheet. Null if the Deal doesn't have them on both sides. */
export function toDealSheet(
  d: DealRecord,
  userId: string,
  urls: Map<string, string | null>,
): DealSheet | null {
  const people = new Map(d.participants.map((p) => [p.userId, p]));
  const person = (id: string): DealPerson => {
    const p = people.get(id);
    return { user_id: id, first_name: p?.displayName ?? null, photo_url: p?.photoUrl ?? null };
  };
  const item = (i: DealItemRecord): DealItem => ({
    id: i.id,
    title: i.title,
    category: i.category,
    brand: i.brand,
    model: i.model,
    condition_grade: i.conditionGrade,
    value:
      i.valueLowCents !== null && i.valueMidCents !== null && i.valueHighCents !== null
        ? {
            low_cents: i.valueLowCents,
            mid_cents: i.valueMidCents,
            high_cents: i.valueHighCents,
            currency: "USD",
          }
        : null,
    photo_url: i.photoPath ? (urls.get(i.photoPath) ?? null) : null,
  });

  const gives = sides(
    d.legs.filter((l) => l.giverId === userId),
    null,
  );
  const yourAsk = gives[0]?.giverAskId ?? null;
  const gets = sides(
    d.legs.filter((l) => l.receiverId === userId),
    yourAsk,
  );
  const [give] = gives;
  const [get] = gets;
  const me = people.get(userId);
  if (!give || !get || !me) return null;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mids = (legs: DealRecord["legs"]) => sum(legs.map((l) => l.item.valueMidCents ?? 0));
  return {
    id: d.id,
    status: d.status,
    expires_at: d.expiresAt.toISOString(),
    gives: gives.map((l) => item(l.item)),
    give_to: person(give.receiverId),
    gets: gets.map((l) => item(l.item)),
    get_from: person(get.giverId),
    you_give: item(give.item),
    you_get: item(get.item),
    cash: {
      pay_cents: sum(d.throwIns.filter((t) => t.payerId === userId).map((t) => t.amountCents)),
      receive_cents: sum(d.throwIns.filter((t) => t.payeeId === userId).map((t) => t.amountCents)),
    },
    fairness: { give_cents: mids(gives), get_cents: mids(gets) },
    loop: d.legs.map((l) => ({
      giver: person(l.giverId),
      receiver: person(l.receiverId),
      item: item(l.item),
    })),
    throw_ins: d.throwIns.map((t) => ({
      payer: person(t.payerId),
      payee: person(t.payeeId),
      amount_cents: t.amountCents,
    })),
    participants: d.participants.map((p) => ({ ...person(p.userId), approval: p.approval })),
    your_approval: me.approval,
    // Each person's own why; nobody sees another participant's.
    why: me.why,
    your_ask_id: yourAsk ?? get.askId,
  };
}

/** 1 side of a Deal in a stable order: Items for `firstAsk` first, then by value. */
function sides(legs: DealRecord["legs"], firstAsk: string | null): DealRecord["legs"] {
  return [...legs].sort(
    (a, b) =>
      Number(b.askId === firstAsk && firstAsk !== null) -
        Number(a.askId === firstAsk && firstAsk !== null) ||
      (b.item.valueMidCents ?? 0) - (a.item.valueMidCents ?? 0) ||
      a.item.id.localeCompare(b.item.id),
  );
}

/**
 * Deal Sheets: each participant sees the same Loop from their own side. Someone else's
 * Deal, or one still staged, is a 404.
 *
 * The PRD wants a fresh device-bound confirmation (Face ID or a passkey) on approve. The
 * server can't verify one until App Attest or passkeys ship (needs the Apple Developer
 * account), so for now the app does the Face ID check locally before calling approve.
 */
export const dealRoutes = (repo: Repository, media: MediaStore) => {
  const sign = async (deals: DealRecord[]) => {
    const paths = deals.flatMap((d) =>
      d.legs.flatMap((l) => (l.item.photoPath ? [l.item.photoPath] : [])),
    );
    return paths.length
      ? media.signedReadUrls([...new Set(paths)])
      : new Map<string, string | null>();
  };
  const sheet = async (d: DealRecord, userId: string) => {
    const out = toDealSheet(d, userId, await sign([d]));
    if (!out) throw notFound();
    return out;
  };
  const decided = async (result: DealDecisionResult, userId: string) => {
    if (result === "not_found") throw notFound();
    if (result === "closed") {
      throw new HttpError(409, "deal_closed", "This Deal isn't waiting for approvals anymore");
    }
    if (result === "decided") {
      throw new HttpError(409, "already_decided", "You already answered this Deal");
    }
    return sheet(result, userId);
  };

  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const userId = c.get("user").id;
      const deals = await repo.listDeals(userId);
      const urls = await sign(deals);
      const body: DealSheetsResponse = {
        deals: deals.flatMap((d) => {
          const s = toDealSheet(d, userId, urls);
          return s ? [s] : [];
        }),
      };
      return c.json(body);
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const userId = c.get("user").id;
      const deal = isUuid(id) ? await repo.getDeal(userId, id.toLowerCase()) : null;
      if (!deal) throw notFound();
      return c.json(await sheet(deal, userId));
    })
    .post("/:id/approve", async (c) => {
      const id = c.req.param("id");
      const userId = c.get("user").id;
      const deal = isUuid(id) ? await repo.getDeal(userId, id.toLowerCase()) : null;
      if (!deal) throw notFound();
      // The snapshot is exactly what this person approved: their own Deal Sheet, now.
      const snapshot = await sheet(deal, userId);
      return c.json(await decided(await repo.approveDeal(userId, deal.id, snapshot), userId));
    })
    .post("/:id/decline", async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) throw notFound();
      const body = await parseJsonBody(c, DealDecline);
      const userId = c.get("user").id;
      const result = await repo.declineDeal(userId, id.toLowerCase(), body.reason ?? null);
      return c.json(await decided(result, userId));
    });
};
