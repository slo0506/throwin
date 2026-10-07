import {
  CounterCreate,
  type DealCounter,
  DealDecline,
  type DealItem,
  type DealPerson,
  type DealSheet,
  type DealSheetsResponse,
  MAX_COUNTER_ROUNDS,
} from "@throwin/shared";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "../lib/body.js";
import type { CounterProblem, Counters } from "../lib/counters.js";
import { HttpError } from "../lib/errors.js";
import type { MediaStore } from "../repo/media.js";
import type {
  DealDecisionResult,
  DealItemRecord,
  DealLegRecord,
  DealRecord,
  Repository,
  ThrowInRecord,
} from "../repo/types.js";
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

  // The Ask the caller gives for: what this Deal fills for them.
  const yourAsk = d.legs.find((l) => l.giverId === userId && l.giverAskId)?.giverAskId ?? null;
  const side = (legs: DealLegRecord[]) => ({
    gives: sides(
      legs.filter((l) => l.giverId === userId),
      null,
    ),
    gets: sides(
      legs.filter((l) => l.receiverId === userId),
      yourAsk,
    ),
  });
  const { gives, gets } = side(d.legs);
  const [give] = gives;
  const [get] = gets;
  const me = people.get(userId);
  if (!give || !get || !me) return null;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mids = (legs: DealLegRecord[]) => sum(legs.map((l) => l.item.valueMidCents ?? 0));
  const cash = (throwIns: ThrowInRecord[]) => ({
    pay_cents: sum(throwIns.filter((t) => t.payerId === userId).map((t) => t.amountCents)),
    receive_cents: sum(throwIns.filter((t) => t.payeeId === userId).map((t) => t.amountCents)),
  });
  const counter = (): DealCounter | null => {
    const c = d.counter;
    if (!c) return null;
    const next = side(c.legs);
    return {
      id: c.id,
      proposed_by: person(c.proposedBy),
      changes: c.changes.flatMap((change) => {
        // A removed Item is only in the Deal as it is; an added one only in the counter.
        const leg = (change.op === "remove" ? d.legs : c.legs).find(
          (l) => l.item.id === change.item_id,
        );
        return leg
          ? [
              {
                op: change.op,
                item: item(leg.item),
                giver: person(leg.giverId),
                receiver: person(leg.receiverId),
              },
            ]
          : [];
      }),
      gives: next.gives.map((l) => item(l.item)),
      gets: next.gets.map((l) => item(l.item)),
      cash: cash(c.throwIns),
      fairness: { give_cents: mids(next.gives), get_cents: mids(next.gets) },
      your_answer: c.awaiting.includes(userId) ? (c.answers[userId] ?? "pending") : null,
      waiting_on: c.awaiting.filter((u) => !c.answers[u]).map(person),
      expires_at: c.expiresAt.toISOString(),
    };
  };
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
    cash: cash(d.throwIns),
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
    your_ask_id: yourAsk ?? gets.find((l) => l.askId)?.askId ?? null,
    counter: counter(),
    counters_left: Math.max(0, MAX_COUNTER_ROUNDS - d.counterRounds),
    superseded_by: d.supersededBy,
  };
}

/** 1 side of a Deal in a stable order: Items for `firstAsk` first, then by value. */
function sides(legs: DealLegRecord[], firstAsk: string | null): DealLegRecord[] {
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
export const dealRoutes = (repo: Repository, media: MediaStore, counters: Counters | null) => {
  const sign = async (deals: DealRecord[]) => {
    const paths = deals.flatMap((d) =>
      [...d.legs, ...(d.counter?.legs ?? [])].flatMap((l) =>
        l.item.photoPath ? [l.item.photoPath] : [],
      ),
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
    if (result === "counter_open") throw counterProblem("counter_open");
    return sheet(result, userId);
  };
  const deal = async (userId: string, id: string) => {
    const found = isUuid(id) ? await repo.getDeal(userId, id.toLowerCase()) : null;
    if (!found) throw notFound();
    return found;
  };
  const counterId = (raw: string) => {
    if (!isUuid(raw)) throw counterNotFound();
    return raw.toLowerCase();
  };

  return (
    new Hono<AppEnv>()
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
      })
      // Counters (docs/contracts/m3-deals.md): ask to change the Items, answer, or take it back.
      .post("/:id/counters", async (c) => {
        if (!counters) {
          throw new HttpError(503, "counters_unavailable", "Counters aren't available right now");
        }
        const userId = c.get("user").id;
        const body = await parseJsonBody(c, CounterCreate);
        const current = await deal(userId, c.req.param("id"));
        const plan = await counters.plan(userId, current, body.changes);
        if (typeof plan === "string") throw counterProblem(plan);
        const result = await repo.proposeCounter(userId, current.id, plan);
        if (result === "not_found") throw notFound();
        // The plan only asks people in the Deal, so `invalid` means it changed under us.
        if (result === "invalid") throw counterProblem("closed");
        if (typeof result === "string") throw counterProblem(result);
        return c.json(await sheet(result, userId), 201);
      })
      .post("/:id/counters/:cid/:answer{accept|decline}", async (c) => {
        const userId = c.get("user").id;
        const current = await deal(userId, c.req.param("id"));
        const result = await repo.respondCounter(
          userId,
          current.id,
          counterId(c.req.param("cid")),
          c.req.param("answer") === "accept",
        );
        if (result === "not_found") throw counterNotFound();
        if (result === "closed") throw counterClosed();
        if (result === "decided") {
          throw new HttpError(409, "already_decided", "You already answered this counter");
        }
        if (result === "items_taken") {
          throw new HttpError(
            409,
            "items_taken",
            "Something in the counter just went to another trade, so it can't happen",
          );
        }
        return c.json(await sheet(result, userId));
      })
      .post("/:id/counters/:cid/withdraw", async (c) => {
        const userId = c.get("user").id;
        const current = await deal(userId, c.req.param("id"));
        const result = await repo.withdrawCounter(
          userId,
          current.id,
          counterId(c.req.param("cid")),
        );
        if (result === "not_found") throw counterNotFound();
        if (result === "closed") throw counterClosed();
        return c.json(await sheet(result, userId));
      })
  );
};

const counterNotFound = () =>
  new HttpError(404, "not_found", "That counter isn't on this Deal, or isn't yours to answer");
const counterClosed = () => new HttpError(409, "counter_closed", "That counter is already settled");

/** Plain words for each reason a counter can't go out. */
export const COUNTER_PROBLEMS: Record<
  CounterProblem,
  { status: 400 | 409 | 422; message: string }
> = {
  closed: { status: 409, message: "This Deal isn't waiting for approvals anymore" },
  counter_open: { status: 409, message: "This Deal is waiting on an answer to a counter" },
  no_rounds_left: { status: 409, message: "This Deal has had its 3 counters" },
  not_in_deal: { status: 400, message: "That Item isn't in this Deal" },
  already_in_deal: { status: 400, message: "That Item is already in this Deal" },
  unavailable: {
    status: 422,
    message: "That Item isn't free to trade: it's not on their Shelf, or another Deal holds it",
  },
  empty_side: { status: 422, message: "Everyone has to give at least 1 thing" },
  not_priced: { status: 422, message: "That Item isn't priced yet" },
  unbalanced: {
    status: 422,
    message: "That would leave someone too far from even, even with cash",
  },
};

function counterProblem(problem: CounterProblem) {
  const { status, message } = COUNTER_PROBLEMS[problem];
  return new HttpError(status, problem === "closed" ? "deal_closed" : problem, message);
}
