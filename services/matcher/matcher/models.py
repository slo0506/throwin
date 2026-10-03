from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Edge(BaseModel):
    """`from_user` wants `item_id`, which `to_user` is willing to give."""

    from_user: str
    to_user: str
    item_id: str
    utility: float = 0.0
    confidence: float = Field(default=1.0, ge=0, le=1)
    kind: Literal["explicit", "inferred"] = "explicit"
    # The wanter's Ask this edge would fill. A selection fills each Ask at most once.
    ask_id: str | None = None
    # The giver's Ask whose offer set holds the Item. In a cycle the giver must receive
    # through this same Ask, so they only give what they offered for it.
    giver_ask_id: str | None = None
    # The Item's value (the middle of its range). Throw-Ins balance on these.
    value_cents: int = Field(default=0, ge=0)
    # The most cash `from_user` would add for this Ask.
    cash_ceiling_cents: int = Field(default=0, ge=0, le=100_000)


class WantGraph(BaseModel):
    edges: list[Edge]
    max_length: int = Field(default=4, ge=2, le=4)
    # Live mode: only cycles that include this user. Drop mode: None.
    anchor_user: str | None = None
    # Enumerating is cheap (all 1,282 cycles of a 200-person Circle take 0.2 s); a low cap
    # would cut drop mode short and favor whoever the search visits first.
    max_cycles: int = Field(default=10_000, ge=1, le=10_000)


class Leg(BaseModel):
    """`receiver` gets `item_id` from `giver`."""

    giver: str
    receiver: str
    item_id: str


class Cycle(BaseModel):
    users: list[str]
    legs: list[Leg]
    utility: float
    min_confidence: float


class CyclesResponse(BaseModel):
    cycles: list[Cycle]
    truncated: bool


class Weights(BaseModel):
    """Score = utility - cash - logistics - risk. Defaults are a starting point for tuning."""

    utility: float = 1.0
    # Per dollar of cash that changes hands.
    cash_per_dollar: float = 0.02
    # Per person beyond 2 (each one is another handoff and another approval).
    extra_person: float = 0.25
    # Times (1 - the lowest edge confidence in the cycle).
    low_confidence: float = 1.0
    # Per inferred edge: the wanter never asked, so a Liaison inquiry must confirm it.
    inferred_edge: float = 0.3


class MatchRequest(WantGraph):
    weights: Weights = Field(default_factory=Weights)
    # Fairness tolerance: max(pct of the larger Item value, floor). PRD: 15% or $10.
    tolerance_pct: float = Field(default=0.15, ge=0, le=1)
    tolerance_floor_cents: int = Field(default=1000, ge=0)
    time_limit_seconds: float = Field(default=5.0, gt=0, le=60)


class ItemLeg(BaseModel):
    """`receiver` gets `item_id` from `giver`. Maps to a deal_legs row with an item."""

    giver: str
    receiver: str
    item_id: str
    value_cents: int
    ask_id: str | None
    giver_ask_id: str | None
    kind: Literal["explicit", "inferred"]


class CashLeg(BaseModel):
    """A Throw-In: `payer` pays `payee`. Maps to a deal_legs row with only throw_in_cents."""

    payer: str
    payee: str
    amount_cents: int = Field(gt=0)


class Fairness(BaseModel):
    """1 participant's side of the Deal. Positive net means they come out ahead."""

    user: str
    gives_cents: int
    gets_cents: int
    cash_in_cents: int
    cash_out_cents: int
    net_cents: int
    tolerance_cents: int


class Deal(BaseModel):
    users: list[str]
    item_legs: list[ItemLeg]
    cash_legs: list[CashLeg]
    fairness: list[Fairness]
    cash_moved_cents: int
    score: float


class MatchResponse(BaseModel):
    deals: list[Deal]
    # Cycles found, how many could be balanced, and whether the search hit max_cycles.
    cycles_found: int
    cycles_balanced: int
    truncated: bool
    # False when the selection hit its time limit; the deals are then the best found so far.
    optimal: bool
