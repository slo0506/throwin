import type { DealDesk } from "@throwin/harness";
import type { CounterCardData, CounterChange, DealSheet } from "@throwin/shared";
import { z } from "zod";
import type { MediaStore } from "../repo/media.js";
import type { DealRecord, Repository } from "../repo/types.js";
import { COUNTER_PROBLEMS, signDealPhotos, toDealSheet } from "../routes/deals.js";
import type { Counters } from "./counters.js";

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/**
 * The GM's view of Deals: exactly the user's own Deal Sheets, and counter previews planned
 * by the same Counters the counter route sends with. Previews store nothing.
 */
export class ApiDealDesk implements DealDesk {
  constructor(
    private readonly repo: Repository,
    private readonly media: MediaStore,
    private readonly counters: Counters | null,
  ) {}

  async list(userId: string): Promise<DealSheet[]> {
    const deals = await this.repo.listDeals(userId);
    const urls = await signDealPhotos(this.media, deals);
    return deals.flatMap((d) => {
      const sheet = toDealSheet(d, userId, urls);
      return sheet ? [sheet] : [];
    });
  }

  async preview(
    userId: string,
    dealId: string,
    changes: CounterChange[],
  ): Promise<CounterCardData | { problem: string; message: string }> {
    if (!this.counters) {
      return { problem: "counters_unavailable", message: "Counters aren't available right now" };
    }
    const deal = isUuid(dealId) ? await this.repo.getDeal(userId, dealId.toLowerCase()) : null;
    if (!deal) return { problem: "not_found", message: "That Deal isn't the user's, or it's gone" };
    const plan = await this.counters.plan(userId, deal, changes);
    if (typeof plan === "string") return { problem: plan, message: COUNTER_PROBLEMS[plan].message };

    // The Deal Sheet as it would read with this counter open: the same code shows real ones.
    const preview: DealRecord = {
      ...deal,
      counter: {
        id: deal.id,
        proposedBy: userId,
        changes,
        legs: plan.legs,
        throwIns: plan.throwIns,
        awaiting: plan.awaiting,
        answers: {},
        expiresAt: deal.expiresAt,
      },
    };
    const sheet = toDealSheet(preview, userId, await signDealPhotos(this.media, [preview]));
    const counter = sheet?.counter;
    if (!sheet || !counter) {
      return { problem: "not_found", message: "That Deal isn't the user's, or it's gone" };
    }
    return {
      deal_id: deal.id,
      changes,
      lines: counter.changes,
      gives: counter.gives,
      gets: counter.gets,
      cash: counter.cash,
      cash_now: sheet.cash,
      waiting_on: counter.waiting_on,
    };
  }
}
