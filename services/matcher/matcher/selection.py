"""Scoring and selection: the best set of balanced cycles that never promises an Item twice.

Each candidate is scored (utility gained, minus penalties for cash, extra people, extra
Items, low confidence and inferred edges), then CP-SAT picks the non-overlapping set with
the most total score. Overlap means sharing an Item, or filling the same Ask twice.
"""

from __future__ import annotations

from dataclasses import dataclass

from ortools.sat.python import cp_model

from .balance import Balanced
from .models import Edge, Weights

# CP-SAT needs integer coefficients; scores keep 3 decimal places.
SCALE = 1000


@dataclass(frozen=True)
class Candidate:
    balanced: Balanced
    score: float

    @property
    def edges(self) -> list[Edge]:
        return [e for leg in self.balanced.legs for e in leg]


def score(balanced: Balanced, w: Weights) -> float:
    edges = [e for leg in balanced.legs for e in leg]
    people = len(balanced.legs)
    utility = sum(e.utility for e in edges)
    cash = balanced.cash_moved_cents / 100 * w.cash_per_dollar
    logistics = (people - 2) * w.extra_person + (len(edges) - people) * w.extra_item
    risk = (1 - min(e.confidence for e in edges)) * w.low_confidence
    inferred = sum(e.kind == "inferred" for e in edges) * w.inferred_edge
    return w.utility * utility - cash - logistics - risk - inferred


def _conflict_keys(edges: list[Edge]) -> set[tuple[str, str, str]]:
    keys = {("item", e.item_id, "") for e in edges}
    keys |= {("ask", e.from_user, e.ask_id) for e in edges if e.ask_id is not None}
    return keys


def select(candidates: list[Candidate], time_limit_seconds: float) -> tuple[list[int], bool]:
    """Indexes of the chosen candidates, best first, and whether the choice is optimal."""
    useful = [i for i, c in enumerate(candidates) if round(c.score * SCALE) > 0]
    if not useful:
        return [], True

    m = cp_model.CpModel()
    pick = {i: m.new_bool_var(f"pick{i}") for i in useful}
    by_key: dict[tuple[str, str, str], list[int]] = {}
    for i in useful:
        for key in _conflict_keys(candidates[i].edges):
            by_key.setdefault(key, []).append(i)
    for members in by_key.values():
        if len(members) > 1:
            m.add_at_most_one(pick[i] for i in members)
    m.maximize(sum(round(candidates[i].score * SCALE) * pick[i] for i in useful))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    # Fixed seed and 1 worker keep results the same from run to run.
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 0
    status = solver.solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return [], False
    chosen = [i for i in useful if solver.value(pick[i])]
    chosen.sort(key=lambda i: -candidates[i].score)
    return chosen, status == cp_model.OPTIMAL
