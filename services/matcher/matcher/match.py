"""The full matcher: cycles, then Throw-In balancing (with bundles), then scoring and
selection."""

from __future__ import annotations

from collections import defaultdict

from .balance import balance, balance_bundle
from .cycles import find_cycle_edges
from .models import Deal, Edge, ItemLeg, MatchRequest, MatchResponse
from .selection import Candidate, score, select

# Items considered per leg when balancing a bundle. Keeps each solve to a few milliseconds.
OPTIONS_PER_LEG = 6


def match(req: MatchRequest) -> MatchResponse:
    found, truncated = find_cycle_edges(req)
    options = _Options(req.edges, req.max_items_per_leg)
    candidates: list[Candidate] = []
    for edges in found:
        balanced = balance([[e] for e in edges], req.tolerance_pct, req.tolerance_floor_cents)
        if balanced is None:
            # Cash alone can't even it out: try other Items from the same offer sets.
            legs = [options.for_leg(e) for e in edges]
            if any(len(leg) > 1 for leg in legs):
                balanced = balance_bundle(
                    legs, req.tolerance_pct, req.tolerance_floor_cents, req.max_items_per_leg
                )
        if balanced is not None:
            candidates.append(Candidate(balanced, score(balanced, req.weights)))

    chosen, optimal = select(candidates, req.time_limit_seconds)
    deals = [_deal(candidates[i]) for i in chosen]
    return MatchResponse(
        deals=deals,
        cycles_found=len(found),
        cycles_balanced=len(candidates),
        truncated=truncated,
        optimal=optimal,
    )


class _Options:
    """What else a giver could hand the same receiver: every edge from the receiver to the
    giver's same Ask (its offer set). With 1 Item per leg, only Items for the cycle's Ask,
    as alternatives; above 1, also Items for the receiver's other Asks, as extras."""

    def __init__(self, edges: list[Edge], max_items_per_leg: int):
        self._extras = max_items_per_leg > 1
        self._by_leg: dict[tuple[str, str, str], list[Edge]] = defaultdict(list)
        for e in edges:
            if e.from_user != e.to_user:
                self._by_leg[(e.from_user, e.to_user, e.giver_ask_id or "")].append(e)

    def for_leg(self, edge: Edge) -> list[Edge]:
        """`edge` first, then the rest: Items for its Ask, then other Asks, best first."""
        rest = sorted(
            (
                e
                for e in self._by_leg[(edge.from_user, edge.to_user, edge.giver_ask_id or "")]
                if (e.ask_id, e.item_id) != (edge.ask_id, edge.item_id)
                and (self._extras or e.ask_id == edge.ask_id)
            ),
            key=lambda e: (e.ask_id != edge.ask_id, -e.utility * e.confidence, e.item_id),
        )
        seen = {(edge.ask_id, edge.item_id)}
        unique = []
        for e in rest:
            if (e.ask_id, e.item_id) not in seen:
                seen.add((e.ask_id, e.item_id))
                unique.append(e)
        return [edge, *unique[: OPTIONS_PER_LEG - 1]]


def _deal(c: Candidate) -> Deal:
    legs = c.balanced.legs
    return Deal(
        users=[leg[0].from_user for leg in legs],
        item_legs=[
            ItemLeg(
                giver=e.to_user,
                receiver=e.from_user,
                item_id=e.item_id,
                value_cents=e.value_cents,
                ask_id=e.ask_id,
                giver_ask_id=e.giver_ask_id,
                kind=e.kind,
            )
            for leg in legs
            for e in leg
        ],
        cash_legs=c.balanced.cash_legs,
        fairness=c.balanced.fairness,
        cash_moved_cents=c.balanced.cash_moved_cents,
        score=round(c.score, 3),
    )
