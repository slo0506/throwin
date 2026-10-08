from __future__ import annotations

from collections import Counter

from fastapi import FastAPI, HTTPException

from .balance import balance_fixed
from .cycles import find_cycles
from .match import match
from .models import (
    BalanceRequest,
    BalanceResponse,
    CyclesResponse,
    MatchRequest,
    MatchResponse,
    WantGraph,
)

app = FastAPI(title="Throw-In matcher", version="0.0.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/cycles", response_model=CyclesResponse)
def cycles(graph: WantGraph) -> CyclesResponse:
    found, truncated = find_cycles(graph)
    return CyclesResponse(cycles=found, truncated=truncated)


@app.post("/v1/match", response_model=MatchResponse)
def match_route(req: MatchRequest) -> MatchResponse:
    """Balanced, non-overlapping Deals for the graph. Live mode sets anchor_user."""
    return match(req)


@app.post("/v1/balance", response_model=BalanceResponse)
def balance_route(req: BalanceRequest) -> BalanceResponse:
    """Throw-Ins for a Deal whose Items are decided, as when a counter changes them."""
    users = [p.user for p in req.people]
    gets: Counter[str] = Counter()
    gives: Counter[str] = Counter()
    for leg in req.item_legs:
        if leg.giver not in users or leg.receiver not in users or leg.giver == leg.receiver:
            raise HTTPException(422, "every leg is between 2 different people in the Deal")
        gets[leg.receiver] += leg.value_cents
        gives[leg.giver] += leg.value_cents
    if len(set(users)) != len(users) or any(
        sum(1 for leg in req.item_legs if leg.receiver == u) == 0
        or sum(1 for leg in req.item_legs if leg.giver == u) == 0
        for u in users
    ):
        raise HTTPException(422, "each person gives and gets at least 1 Item")
    if len({leg.item_id for leg in req.item_legs}) != len(req.item_legs):
        raise HTTPException(422, "an Item appears twice")
    result = balance_fixed(
        users,
        [gets[u] for u in users],
        [gives[u] for u in users],
        [p.cash_ceiling_cents for p in req.people],
        req.tolerance_pct,
        req.tolerance_floor_cents,
    )
    if result is None:
        return BalanceResponse(balanced=False)
    cash_legs, fairness = result
    return BalanceResponse(
        balanced=True,
        cash_legs=cash_legs,
        fairness=fairness,
        cash_moved_cents=sum(c.amount_cents for c in cash_legs),
    )
