from __future__ import annotations

from fastapi import FastAPI

from .cycles import find_cycles
from .match import match
from .models import CyclesResponse, MatchRequest, MatchResponse, WantGraph

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
