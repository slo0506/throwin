"""Throw-In balancing for 1 cycle.

Each person's value received minus value given, plus cash received minus cash paid, must
land within a tolerance (PRD: 15% of the larger Item value or $10, whichever is greater).
Nobody pays more than the cash ceiling on the Ask the cycle fills for them, and the cash
that changes hands is as small as possible. Amounts are whole cents, so this is a small
integer program rather than a float LP that would need rounding afterwards.
"""

from __future__ import annotations

from dataclasses import dataclass

from ortools.sat.python import cp_model

from .models import CashLeg, Edge, Fairness


@dataclass(frozen=True)
class Balanced:
    cash_legs: list[CashLeg]
    fairness: list[Fairness]
    cash_moved_cents: int


def _tolerance(gets: int, gives: int, pct: float, floor: int) -> int:
    return max(int(pct * max(gets, gives)), floor)


def balance(edges: list[Edge], tolerance_pct: float, floor_cents: int) -> Balanced | None:
    """`edges[i]` is what `edges[i].from_user` receives; they give `edges[i - 1]`'s Item.

    Returns None when no Throw-Ins within the cash ceilings make everyone close to even.
    """
    n = len(edges)
    users = [e.from_user for e in edges]
    gets = [e.value_cents for e in edges]
    gives = [edges[i - 1].value_cents for i in range(n)]
    ceilings = [e.cash_ceiling_cents for e in edges]
    tols = [_tolerance(gets[i], gives[i], tolerance_pct, floor_cents) for i in range(n)]
    surplus = [gets[i] - gives[i] for i in range(n)]

    if all(abs(s) <= t for s, t in zip(surplus, tols, strict=True)):
        cash = [0] * n
    else:
        solved = _solve(surplus, tols, ceilings)
        if solved is None:
            return None
        cash = solved

    fairness = [
        Fairness(
            user=users[i],
            gives_cents=gives[i],
            gets_cents=gets[i],
            cash_in_cents=max(cash[i], 0),
            cash_out_cents=max(-cash[i], 0),
            net_cents=surplus[i] + cash[i],
            tolerance_cents=tols[i],
        )
        for i in range(n)
    ]
    legs = _settle(users, cash)
    return Balanced(
        cash_legs=legs,
        fairness=fairness,
        cash_moved_cents=sum(leg.amount_cents for leg in legs),
    )


def _solve(surplus: list[int], tols: list[int], ceilings: list[int]) -> list[int] | None:
    """Net cash per person (positive means they receive), or None if infeasible."""
    n = len(surplus)
    total_ceiling = sum(ceilings)
    if total_ceiling == 0:
        return None
    m = cp_model.CpModel()
    cash = [m.new_int_var(-ceilings[i], total_ceiling, f"cash{i}") for i in range(n)]
    paid = [m.new_int_var(0, ceilings[i], f"paid{i}") for i in range(n)]
    # Distance from even, kept as a tie-breaker so equal-cash answers favor fairness.
    off = [m.new_int_var(0, tols[i], f"off{i}") for i in range(n)]
    m.add(sum(cash) == 0)
    for i in range(n):
        m.add(paid[i] >= -cash[i])
        m.add_abs_equality(off[i], surplus[i] + cash[i])
    # Cash moved dominates: 1 cent of cash outweighs any total distance from even.
    weight = sum(tols) + 1
    m.minimize(weight * sum(paid) + sum(off))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 1.0
    solver.parameters.num_workers = 1
    status = solver.solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    return [solver.value(c) for c in cash]


def _settle(users: list[str], cash: list[int]) -> list[CashLeg]:
    """Turn net cash into payer-to-payee transfers: biggest payer to biggest payee first."""
    payers = sorted(((-c, u) for u, c in zip(users, cash, strict=True) if c < 0), reverse=True)
    payees = sorted(((c, u) for u, c in zip(users, cash, strict=True) if c > 0), reverse=True)
    owed = [[amount, user] for amount, user in payers]
    due = [[amount, user] for amount, user in payees]
    legs: list[CashLeg] = []
    i = j = 0
    while i < len(owed) and j < len(due):
        amount = min(owed[i][0], due[j][0])
        legs.append(CashLeg(payer=owed[i][1], payee=due[j][1], amount_cents=amount))
        owed[i][0] -= amount
        due[j][0] -= amount
        if owed[i][0] == 0:
            i += 1
        if due[j][0] == 0:
            j += 1
    return legs
