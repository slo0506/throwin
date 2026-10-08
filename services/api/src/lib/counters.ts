import { type CounterChange, MAX_COUNTER_ROUNDS } from "@throwin/shared";
import type { CounterProposal, DealLegRecord, DealRecord, Repository } from "../repo/types.js";
import type { Balancer } from "./matcher.js";

/** Why a counter can't go out, as codes the route and the GM turn into words. */
export type CounterProblem =
  | "closed"
  | "counter_open"
  | "no_rounds_left"
  | "not_in_deal"
  | "already_in_deal"
  | "unavailable"
  | "empty_side"
  | "not_priced"
  | "unbalanced";

/**
 * Turns a counter's changes into the Deal they'd make (docs/contracts/m3-deals.md,
 * "Counters"). Checks each change against the Deal as it is, has the matcher re-balance the
 * cash within everyone's ceilings, and works out who has to accept: everyone else whose
 * side changes. The route sends what it plans, and the GM previews with it.
 */
export class Counters {
  constructor(
    private readonly repo: Pick<Repository, "getCounterItems" | "getAskCeilings">,
    private readonly balancer: Balancer,
  ) {}

  async plan(
    userId: string,
    deal: DealRecord,
    changes: CounterChange[],
  ): Promise<CounterProposal | CounterProblem> {
    if (deal.status !== "pending_approvals") return "closed";
    if (deal.counter) return "counter_open";
    if (deal.counterRounds >= MAX_COUNTER_ROUNDS) return "no_rounds_left";

    // In a Loop each person hands everything to 1 other person.
    const giveTo = new Map(deal.legs.map((l) => [l.giverId, l.receiverId]));
    const adds = changes.flatMap((c) => (c.op === "add" ? [c.item_id] : []));
    const found = new Map(
      (await this.repo.getCounterItems(adds)).map((i) => [i.item.id, i] as const),
    );
    const removed = new Set<string>();
    const added: DealLegRecord[] = [];
    const touched = new Set<string>();
    for (const change of changes) {
      if (change.op === "remove") {
        const leg = deal.legs.find((l) => l.item.id === change.item_id);
        if (!leg || removed.has(change.item_id)) return "not_in_deal";
        removed.add(change.item_id);
        touched.add(leg.giverId).add(leg.receiverId);
        continue;
      }
      if ([...deal.legs, ...added].some((l) => l.item.id === change.item_id)) {
        return "already_in_deal";
      }
      const candidate = found.get(change.item_id);
      const receiver = candidate && giveTo.get(candidate.ownerId);
      if (
        !candidate ||
        !receiver ||
        candidate.status !== "on_shelf" ||
        candidate.reserved ||
        candidate.willingness === "not_available"
      ) {
        return "unavailable";
      }
      added.push({
        giverId: candidate.ownerId,
        receiverId: receiver,
        askId: null,
        giverAskId: null,
        item: candidate.item,
      });
      touched.add(candidate.ownerId).add(receiver);
    }

    const legs = [...deal.legs.filter((l) => !removed.has(l.item.id)), ...added];
    if ([...giveTo.keys()].some((giver) => !legs.some((l) => l.giverId === giver))) {
      return "empty_side";
    }
    if (legs.some((l) => l.item.valueMidCents === null)) return "not_priced";

    // Each person's ceiling is the Ask they give for (bundles), or on older Deals the Ask
    // they receive through.
    const people = deal.participants.map((p) => p.userId);
    const askOf = new Map(
      people.map((u) => [
        u,
        deal.legs.find((l) => l.giverId === u && l.giverAskId)?.giverAskId ??
          deal.legs.find((l) => l.receiverId === u && l.askId)?.askId ??
          null,
      ]),
    );
    const ceilings = await this.repo.getAskCeilings(
      [...askOf.values()].filter((a): a is string => a !== null),
    );
    const balanced = await this.balancer.balance({
      people: people.map((u) => ({
        user: u,
        cash_ceiling_cents: ceilings.get(askOf.get(u) ?? "") ?? 0,
      })),
      item_legs: legs.map((l) => ({
        giver: l.giverId,
        receiver: l.receiverId,
        item_id: l.item.id,
        value_cents: l.item.valueMidCents ?? 0,
      })),
    });
    if (!balanced.balanced) return "unbalanced";

    return {
      changes,
      proposal: {
        item_legs: legs.map((l) => ({
          giver: l.giverId,
          receiver: l.receiverId,
          item_id: l.item.id,
          ask_id: l.askId,
          giver_ask_id: l.giverAskId,
          value_cents: l.item.valueMidCents ?? 0,
        })),
        cash_legs: balanced.cash_legs,
        fairness: balanced.fairness,
        cash_moved_cents: balanced.cash_moved_cents,
      },
      awaiting: [...touched].filter((u) => u !== userId),
    };
  }
}
