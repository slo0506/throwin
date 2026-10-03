from __future__ import annotations

from pydantic import BaseModel, Field


class Edge(BaseModel):
    """`from_user` wants `item_id`, which `to_user` is willing to give."""

    from_user: str
    to_user: str
    item_id: str
    utility: float = 0.0
    confidence: float = Field(default=1.0, ge=0, le=1)
    kind: str = "explicit"


class WantGraph(BaseModel):
    edges: list[Edge]
    max_length: int = Field(default=4, ge=2, le=4)
    # Live mode: only cycles that include this user. Drop mode: None.
    anchor_user: str | None = None
    max_cycles: int = Field(default=500, ge=1, le=10_000)


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
