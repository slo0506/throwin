"""Property tests over random Circles: the rules hold for every Deal the matcher returns."""

import random
import time
from collections import Counter, defaultdict

import pytest

from matcher.match import match
from matcher.models import Edge, MatchRequest, MatchResponse


def random_circle(seed: int, users: int, wants_per_user: int) -> list[Edge]:
    rng = random.Random(seed)
    names = [f"u{i:03d}" for i in range(users)]
    items = {
        u: [(f"{u}-i{k}", rng.randint(5, 300) * 100) for k in range(rng.randint(1, 3))]
        for u in names
    }
    edges: list[Edge] = []
    for u in names:
        ask = f"{u}-ask"
        ceiling = rng.choice([0, 0, 1000, 2500, 5000, 20000])
        others = rng.sample([v for v in names if v != u], k=min(wants_per_user, users - 1))
        for v in others:
            item_id, value = rng.choice(items[v])
            edges.append(
                Edge(
                    from_user=u,
                    to_user=v,
                    item_id=item_id,
                    value_cents=value,
                    cash_ceiling_cents=ceiling,
                    utility=round(rng.uniform(0.2, 2.0), 2),
                    confidence=round(rng.uniform(0.5, 1.0), 2),
                    kind=rng.choice(["explicit", "explicit", "inferred"]),
                    ask_id=ask,
                )
            )
    return edges


def check_rules(req: MatchRequest, res: MatchResponse) -> None:
    known = {(e.from_user, e.to_user, e.item_id): e for e in req.edges}
    items_used: Counter[str] = Counter()
    asks_used: Counter[tuple[str, str | None]] = Counter()

    for deal in res.deals:
        n = len(deal.users)
        assert 2 <= n <= req.max_length
        assert len(set(deal.users)) == n
        if req.anchor_user:
            assert req.anchor_user in deal.users

        # Every leg is a real want, and each person gives 1 Item and gets 1 Item.
        gets: dict[str, int] = {}
        gives: dict[str, int] = {}
        for leg in deal.item_legs:
            edge = known[(leg.receiver, leg.giver, leg.item_id)]
            assert leg.value_cents == edge.value_cents
            gets[leg.receiver] = leg.value_cents
            gives[leg.giver] = leg.value_cents
            items_used[leg.item_id] += 1
            if leg.ask_id is not None:
                asks_used[(leg.receiver, leg.ask_id)] += 1
        assert set(gets) == set(gives) == set(deal.users)

        # Cash legs add up to each person's cash in and out, and nothing else moves.
        cash_in: dict[str, int] = defaultdict(int)
        cash_out: dict[str, int] = defaultdict(int)
        for c in deal.cash_legs:
            assert c.amount_cents > 0 and c.payer != c.payee
            assert {c.payer, c.payee} <= set(deal.users)
            cash_in[c.payee] += c.amount_cents
            cash_out[c.payer] += c.amount_cents
        assert deal.cash_moved_cents == sum(c.amount_cents for c in deal.cash_legs)

        ceilings = {
            leg.receiver: known[(leg.receiver, leg.giver, leg.item_id)].cash_ceiling_cents
            for leg in deal.item_legs
        }
        for f in deal.fairness:
            assert f.gets_cents == gets[f.user] and f.gives_cents == gives[f.user]
            assert f.cash_in_cents - f.cash_out_cents == cash_in[f.user] - cash_out[f.user]
            # Nobody pays over their Ask's ceiling.
            assert cash_out[f.user] <= ceilings[f.user]
            # Everyone nets within tolerance: max(15% of the larger Item, $10).
            expected_tol = max(
                int(req.tolerance_pct * max(f.gets_cents, f.gives_cents)), req.tolerance_floor_cents
            )
            assert f.tolerance_cents == expected_tol
            assert f.net_cents == f.gets_cents - f.gives_cents + f.cash_in_cents - f.cash_out_cents
            assert abs(f.net_cents) <= f.tolerance_cents

    # No Item is in 2 Deals, and no Ask is filled twice.
    assert all(count == 1 for count in items_used.values())
    assert all(count == 1 for count in asks_used.values())


@pytest.mark.parametrize("seed", range(150))
def test_drop_mode_rules_hold(seed: int):
    rng = random.Random(seed)
    req = MatchRequest(
        edges=random_circle(seed, users=rng.randint(3, 25), wants_per_user=rng.randint(1, 5)),
        max_length=rng.choice([2, 3, 4]),
        time_limit_seconds=2,
    )
    res = match(req)
    check_rules(req, res)


@pytest.mark.parametrize("seed", range(50))
def test_live_mode_rules_hold(seed: int):
    edges = random_circle(1000 + seed, users=40, wants_per_user=4)
    req = MatchRequest(edges=edges, anchor_user=f"u{seed % 40:03d}", time_limit_seconds=2)
    res = match(req)
    check_rules(req, res)
    # Live mode fills the anchor's Ask at most once, so it returns at most 1 Deal.
    assert len(res.deals) <= 1


def test_a_cash_throw_in_shows_up_in_random_circles():
    # Guards against the property tests passing only because nothing ever needs cash.
    with_cash = 0
    for seed in range(60):
        req = MatchRequest(edges=random_circle(seed, users=20, wants_per_user=4))
        with_cash += sum(1 for d in match(req).deals if d.cash_legs)
    assert with_cash > 0


def test_live_match_in_a_circle_of_200_is_fast():
    # PRD Milestone 3: live matching returns a Deal in under 10 seconds for 200 people.
    edges = random_circle(7, users=200, wants_per_user=8)
    started = time.perf_counter()
    found = 0
    for anchor in ("u000", "u050", "u100", "u150", "u199"):
        req = MatchRequest(edges=edges, anchor_user=anchor)
        res = match(req)
        check_rules(req, res)
        found += len(res.deals)
    per_anchor = (time.perf_counter() - started) / 5
    assert found > 0
    assert per_anchor < 10, f"{per_anchor:.2f}s per live match"
