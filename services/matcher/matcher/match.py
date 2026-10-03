"""The full matcher: cycles, then Throw-In balancing, then scoring and selection."""

from __future__ import annotations

from .balance import balance
from .cycles import find_cycle_edges
from .models import Deal, ItemLeg, MatchRequest, MatchResponse
from .selection import Candidate, score, select


def match(req: MatchRequest) -> MatchResponse:
    found, truncated = find_cycle_edges(req)
    candidates: list[Candidate] = []
    for edges in found:
        balanced = balance(edges, req.tolerance_pct, req.tolerance_floor_cents)
        if balanced is not None:
            candidates.append(Candidate(edges, balanced, score(edges, balanced, req.weights)))

    chosen, optimal = select(candidates, req.time_limit_seconds)
    deals = [_deal(candidates[i]) for i in chosen]
    return MatchResponse(
        deals=deals,
        cycles_found=len(found),
        cycles_balanced=len(candidates),
        truncated=truncated,
        optimal=optimal,
    )


def _deal(c: Candidate) -> Deal:
    return Deal(
        users=[e.from_user for e in c.edges],
        item_legs=[
            ItemLeg(
                giver=e.to_user,
                receiver=e.from_user,
                item_id=e.item_id,
                value_cents=e.value_cents,
                ask_id=e.ask_id,
                kind=e.kind,
            )
            for e in c.edges
        ],
        cash_legs=c.balanced.cash_legs,
        fairness=c.balanced.fairness,
        cash_moved_cents=c.balanced.cash_moved_cents,
        score=round(c.score, 3),
    )
