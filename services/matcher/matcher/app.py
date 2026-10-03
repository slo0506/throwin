from __future__ import annotations

from fastapi import FastAPI

from .cycles import find_cycles
from .models import CyclesResponse, WantGraph

app = FastAPI(title="Throw-In matcher", version="0.0.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/cycles", response_model=CyclesResponse)
def cycles(graph: WantGraph) -> CyclesResponse:
    # Milestone 3 adds Throw-In balancing (LP) and non-overlapping selection (CP-SAT).
    found, truncated = find_cycles(graph)
    return CyclesResponse(cycles=found, truncated=truncated)
