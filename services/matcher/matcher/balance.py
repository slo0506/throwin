"""Throw-In balancing for 1 cycle, with bundles.

Each person's value received minus value given, plus cash received minus cash paid, must
land within a tolerance (PRD: 15% of the larger side's value or $10, whichever is greater).
Nobody pays more than the cash ceiling on the Ask the cycle fills for them, and the cash
that changes hands is as small as possible. Amounts are whole cents, so these are small
integer programs rather than float LPs that would need rounding afterwards.

When cash alone can't even a cycle out, `balance_bundle` also chooses the Items: a giver
can hand over a different Item from the same offer set, or extra ones the receiver's Asks
want (X for Y), adding as few Items as it can.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from ortools.sat.python import cp_model

from .models import CashLeg, Edge, Fairness

BASIS = 10_000


@dataclass(frozen=True)
class Balanced:
    # legs[i] is what person i receives, from the person after them in the cycle. The
    # first Item of each leg fills the Ask the cycle fills for them.
    legs: list[list[Edge]]
    cash_legs: list[CashLeg]
    fairness: list[Fairness]
    cash_moved_cents: int


def _bp(pct: float) -> int:
    return round(pct * BASIS)


def _tolerance(gets: int, gives: int, pct: float, floor: int) -> int:
    # Integer basis points, so the solver and this check agree to the cent.
    return max(_bp(pct) * max(gets, gives) // BASIS, floor)


def balance(legs: list[list[Edge]], tolerance_pct: float, floor_cents: int) -> Balanced | None:
    """Throw-Ins for fixed Items: person i receives `legs[i]` and gives `legs[i - 1]`.

    Returns None when no Throw-Ins within the cash ceilings make everyone close to even.
    """
    n = len(legs)
    gets = [sum(e.value_cents for e in leg) for leg in legs]
    gives = [gets[i - 1] for i in range(n)]
    ceilings = [leg[0].cash_ceiling_cents for leg in legs]
    tols = [_tolerance(gets[i], gives[i], tolerance_pct, floor_cents) for i in range(n)]
    surplus = [gets[i] - gives[i] for i in range(n)]

    if all(abs(s) <= t for s, t in zip(surplus, tols, strict=True)):
        cash = [0] * n
    else:
        solved = _solve(surplus, tols, ceilings)
        if solved is None:
            return None
        cash = solved
    return _finish(legs, cash, tolerance_pct, floor_cents)


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


def balance_bundle(
    options: list[list[Edge]],
    tolerance_pct: float,
    floor_cents: int,
    max_items_per_leg: int,
) -> Balanced | None:
    """Picks the Items as well as the Throw-Ins.

    `options[i]` holds what person i could receive from the person after them, all from
    that giver's offer set for the cycle, best first: the first is the cycle's own edge,
    and any `options[i][j]` with the same `ask_id` fills the same Ask. Each person gets at
    least 1 Item for that Ask, no Ask more Items than it takes (`max_items`), and no more
    than `max_items_per_leg` in all. Minimizes, in order: Items beyond 1 per person, cash,
    how far down each list the Items come from, and distance from even.
    """
    n = len(options)
    bp = _bp(tolerance_pct)
    total = sum(e.value_cents for opts in options for e in opts)
    tol_cap = max(floor_cents, bp * total // BASIS)
    ceilings = [opts[0].cash_ceiling_cents for opts in options]
    total_ceiling = sum(ceilings)

    m = cp_model.CpModel()
    pick = [
        [m.new_bool_var(f"x{i}_{j}") for j in range(len(opts))] for i, opts in enumerate(options)
    ]
    gets = [m.new_int_var(0, total, f"gets{i}") for i in range(n)]
    for i, opts in enumerate(options):
        m.add(gets[i] == sum(e.value_cents * pick[i][j] for j, e in enumerate(opts)))
        by_ask: dict[str | None, list[int]] = defaultdict(list)
        by_item: dict[str, list[int]] = defaultdict(list)
        for j, e in enumerate(opts):
            by_ask[e.ask_id].append(j)
            by_item[e.item_id].append(j)
        m.add(sum(pick[i][j] for j in by_ask[opts[0].ask_id]) >= 1)
        for js in by_ask.values():
            m.add(sum(pick[i][j] for j in js) <= min(opts[j].max_items for j in js))
        for js in by_item.values():
            if len(js) > 1:
                m.add_at_most_one(pick[i][j] for j in js)
        m.add(sum(pick[i]) <= max_items_per_leg)

    cash = [m.new_int_var(-ceilings[i], total_ceiling, f"cash{i}") for i in range(n)]
    paid = [m.new_int_var(0, ceilings[i], f"paid{i}") for i in range(n)]
    off = [m.new_int_var(0, tol_cap, f"off{i}") for i in range(n)]
    m.add(sum(cash) == 0)
    for i in range(n):
        larger = m.new_int_var(0, total, f"larger{i}")
        m.add_max_equality(larger, [gets[i], gets[i - 1]])
        share = m.new_int_var(0, tol_cap, f"share{i}")
        m.add_division_equality(share, bp * larger, BASIS)
        tol = m.new_int_var(0, tol_cap, f"tol{i}")
        m.add_max_equality(tol, [share, floor_cents])
        net = gets[i] - gets[i - 1] + cash[i]
        m.add(net <= tol)
        m.add(net >= -tol)
        m.add(paid[i] >= -cash[i])
        m.add_abs_equality(off[i], net)

    # Each term outweighs everything after it.
    extra = sum(sum(row) for row in pick) - n
    rank = sum(j * x for row in pick for j, x in enumerate(row))
    max_rank = sum(len(row) * (len(row) - 1) // 2 for row in pick)
    w_rank = n * tol_cap + 1
    w_cash = w_rank * (max_rank + 1)
    w_extra = w_cash * (total_ceiling + 1)
    m.minimize(w_extra * extra + w_cash * sum(paid) + w_rank * rank + sum(off))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 1.0
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 0
    if solver.solve(m) not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    legs = []
    for i, opts in enumerate(options):
        chosen = [e for j, e in enumerate(opts) if solver.value(pick[i][j])]
        # Items for the cycle's Ask first (stable), so leg[0] carries its cash ceiling.
        legs.append(sorted(chosen, key=lambda e, ask=opts[0].ask_id: e.ask_id != ask))
    return _finish(legs, [solver.value(c) for c in cash], tolerance_pct, floor_cents)


def _finish(
    legs: list[list[Edge]], cash: list[int], tolerance_pct: float, floor_cents: int
) -> Balanced | None:
    n = len(legs)
    gets = [sum(e.value_cents for e in leg) for leg in legs]
    fairness = []
    for i in range(n):
        gives = gets[i - 1]
        tol = _tolerance(gets[i], gives, tolerance_pct, floor_cents)
        net = gets[i] - gives + cash[i]
        if abs(net) > tol or -cash[i] > legs[i][0].cash_ceiling_cents:
            return None
        fairness.append(
            Fairness(
                user=legs[i][0].from_user,
                gives_cents=gives,
                gets_cents=gets[i],
                cash_in_cents=max(cash[i], 0),
                cash_out_cents=max(-cash[i], 0),
                net_cents=net,
                tolerance_cents=tol,
            )
        )
    cash_legs = _settle([leg[0].from_user for leg in legs], cash)
    return Balanced(
        legs=legs,
        cash_legs=cash_legs,
        fairness=fairness,
        cash_moved_cents=sum(c.amount_cents for c in cash_legs),
    )


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
