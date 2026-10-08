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
    # How many Items the wanter's Ask takes ("2 or 3 board games"). 1 for most Asks.
    max_items: int = Field(default=1, ge=1, le=5)


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
    # Times the share of the traded value that moves as cash (cash moved / Item value). A share,
    # not dollars, so a $300 trade needing $80 of cash isn't priced out the way a flat
    # per-dollar penalty prices it out.
    cash_share: float = 1.0
    # Per person beyond 2 (each one is another handoff and another approval).
    extra_person: float = 0.25
    # Times (1 - the lowest edge confidence in the cycle).
    low_confidence: float = 1.0
    # Per inferred edge: the wanter never asked, so a Liaison inquiry must confirm it.
    inferred_edge: float = 0.3
    # Per Item beyond the first that 1 person hands another: 1 more thing to hand over.
    extra_item: float = 0.15


class MatchRequest(WantGraph):
    weights: Weights = Field(default_factory=Weights)
    # Fairness tolerance: max(pct of the larger Item value, floor). PRD: 15% or $10.
    tolerance_pct: float = Field(default=0.15, ge=0, le=1)
    tolerance_floor_cents: int = Field(default=1000, ge=0)
    # Items 1 person may hand another in 1 Deal (X for Y). At 1, every Deal is 1 Item each
    # way. Above 1, when cash alone can't even a Loop out, a giver can add Items from the
    # same offer set that the receiver's Asks want.
    max_items_per_leg: int = Field(default=1, ge=1, le=5)
    time_limit_seconds: float = Field(default=5.0, gt=0, le=60)


class ItemLeg(BaseModel):
    """`receiver` gets `item_id` from `giver`. Maps to a deal_legs row with an item.

    A bundle is several ItemLegs with the same giver and receiver.
    """

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
    """1 participant's side of the Deal, summed over their Items. Positive net means they
    come out ahead."""

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


class BalancePerson(BaseModel):
    user: str
    # The most cash they'd add: the ceiling of the Ask the Deal fills for them.
    cash_ceiling_cents: int = Field(default=0, ge=0, le=100_000)


class FixedItemLeg(BaseModel):
    """`receiver` gets `item_id` from `giver`."""

    giver: str
    receiver: str
    item_id: str
    value_cents: int = Field(ge=0)


class BalanceRequest(BaseModel):
    """Throw-Ins for a Deal whose Items are already decided, as when a counter changes them."""

    people: list[BalancePerson] = Field(min_length=2, max_length=4)
    item_legs: list[FixedItemLeg] = Field(min_length=2, max_length=20)
    tolerance_pct: float = Field(default=0.15, ge=0, le=1)
    tolerance_floor_cents: int = Field(default=1000, ge=0)


class BalanceResponse(BaseModel):
    # False when no Throw-Ins within the ceilings bring everyone close to even.
    balanced: bool
    cash_legs: list[CashLeg] = Field(default_factory=list)
    fairness: list[Fairness] = Field(default_factory=list)
    cash_moved_cents: int = 0


class MatchResponse(BaseModel):
    deals: list[Deal]
    # Cycles found, how many could be balanced, and whether the search hit max_cycles.
    cycles_found: int
    cycles_balanced: int
    truncated: bool
    # False when the selection hit its time limit; the deals are then the best found so far.
    optimal: bool
