import type { DealDesk } from "@throwin/harness";
import type { CounterCardData, CounterChange, DealItem, DealSheet } from "@throwin/shared";
import { z } from "zod";

// Deals for GM eval cases: a stand-in for the API's DealDesk that serves Deal Sheets from
// the case and previews counters with the same rules (Items free and in reach, everyone
// still giving something). Cash moves by the value that changes hands, which is close
// enough for grading what the GM staged and how it described it.

const cents = z.number().int().nonnegative();
const Value = z.strictObject({ low: cents, mid: cents, high: cents });
const EvalDealItem = z.strictObject({ id: z.uuid(), title: z.string(), value_cents: Value });

/** `state.deals`: open 2-person Deals, from the eval user's side. */
export const EvalDeal = z.strictObject({
  id: z.uuid(),
  with: z.strictObject({ user_id: z.uuid(), first_name: z.string() }),
  gives: z.array(EvalDealItem).min(1),
  gets: z.array(EvalDealItem).min(1),
  pay_cents: cents.default(0),
  receive_cents: cents.default(0),
  counters_left: z.number().int().min(0).max(3).default(3),
});
export type EvalDeal = z.infer<typeof EvalDeal>;

/** An Item a counter could add: the user's own, or someone's in the Circle. */
export interface ReachableItem {
  id: string;
  ownerId: string;
  title: string;
  value: { low: number; mid: number; high: number } | null;
}

const dealItem = (i: { id: string; title: string; value: ReachableItem["value"] }): DealItem => ({
  id: i.id,
  title: i.title,
  category: null,
  brand: null,
  model: null,
  condition_grade: null,
  value: i.value
    ? { low_cents: i.value.low, mid_cents: i.value.mid, high_cents: i.value.high, currency: "USD" }
    : null,
  photo_url: null,
});

const fromCase = (i: z.infer<typeof EvalDealItem>) =>
  dealItem({ id: i.id, title: i.title, value: i.value_cents });

export class EvalDealDesk implements DealDesk {
  /** Every counter the GM previewed, in order. */
  readonly previews: CounterChange[][] = [];

  constructor(
    private readonly user: { id: string; firstName: string },
    private readonly deals: EvalDeal[],
    private readonly reach: (itemId: string) => ReachableItem | null,
  ) {}

  async list(): Promise<DealSheet[]> {
    return this.deals.map((d) => this.#sheet(d));
  }

  async preview(
    _userId: string,
    dealId: string,
    changes: CounterChange[],
  ): Promise<CounterCardData | { problem: string; message: string }> {
    this.previews.push(changes);
    const deal = this.deals.find((d) => d.id === dealId);
    if (deal?.counters_left === 0) {
      return { problem: "no_rounds_left", message: "This Deal has had its 3 counters" };
    }
    if (!deal) return { problem: "not_found", message: "That Deal isn't the user's, or it's gone" };
    const me = { user_id: this.user.id, first_name: this.user.firstName, photo_url: null };
    const them = { user_id: deal.with.user_id, first_name: deal.with.first_name, photo_url: null };
    let gives = deal.gives.map(fromCase);
    let gets = deal.gets.map(fromCase);
    const lines: CounterCardData["lines"] = [];
    for (const change of changes) {
      if (change.op === "remove") {
        const mine = gives.find((i) => i.id === change.item_id);
        const theirs = gets.find((i) => i.id === change.item_id);
        if (!mine && !theirs)
          return { problem: "not_in_deal", message: "That Item isn't in this Deal" };
        gives = gives.filter((i) => i.id !== change.item_id);
        gets = gets.filter((i) => i.id !== change.item_id);
        lines.push({
          op: "remove",
          item: (mine ?? theirs) as DealItem,
          giver: mine ? me : them,
          receiver: mine ? them : me,
        });
        continue;
      }
      const found = this.reach(change.item_id);
      if (!found || ![this.user.id, deal.with.user_id].includes(found.ownerId)) {
        return {
          problem: "unavailable",
          message:
            "That Item isn't free to trade: it's not on their Shelf, or another Deal holds it",
        };
      }
      if ([...gives, ...gets].some((i) => i.id === found.id)) {
        return { problem: "already_in_deal", message: "That Item is already in this Deal" };
      }
      const item = dealItem(found);
      const mine = found.ownerId === this.user.id;
      if (mine) gives = [...gives, item];
      else gets = [...gets, item];
      lines.push({ op: "add", item, giver: mine ? me : them, receiver: mine ? them : me });
    }
    if (gives.length === 0 || gets.length === 0) {
      return { problem: "empty_side", message: "Everyone has to give at least 1 thing" };
    }
    const value = (items: DealItem[]) => items.reduce((s, i) => s + (i.value?.mid_cents ?? 0), 0);
    const owed =
      deal.pay_cents -
      deal.receive_cents +
      (value(gets) - value(deal.gets.map(fromCase))) -
      (value(gives) - value(deal.gives.map(fromCase)));
    return {
      deal_id: deal.id,
      changes,
      lines,
      gives,
      gets,
      cash: { pay_cents: Math.max(0, owed), receive_cents: Math.max(0, -owed) },
      cash_now: { pay_cents: deal.pay_cents, receive_cents: deal.receive_cents },
      waiting_on: [them],
    };
  }

  #sheet(d: EvalDeal): DealSheet {
    const me = { user_id: this.user.id, first_name: this.user.firstName, photo_url: null };
    const them = { user_id: d.with.user_id, first_name: d.with.first_name, photo_url: null };
    const gives = d.gives.map(fromCase);
    const gets = d.gets.map(fromCase);
    const sum = (items: DealItem[]) => items.reduce((s, i) => s + (i.value?.mid_cents ?? 0), 0);
    return {
      id: d.id,
      status: "pending_approvals",
      expires_at: "2026-10-05T12:00:00.000Z",
      gives,
      give_to: them,
      gets,
      get_from: them,
      you_give: gives[0] as DealItem,
      you_get: gets[0] as DealItem,
      cash: { pay_cents: d.pay_cents, receive_cents: d.receive_cents },
      fairness: { give_cents: sum(gives), get_cents: sum(gets) },
      loop: [],
      throw_ins: [],
      participants: [
        { ...me, approval: "pending" },
        { ...them, approval: "pending" },
      ],
      your_approval: "pending",
      why: null,
      your_ask_id: null,
      counter: null,
      counters_left: d.counters_left,
      superseded_by: null,
    };
  }
}
