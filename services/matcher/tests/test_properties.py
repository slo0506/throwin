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
                    # Each person has 1 Ask, and its offer set holds all their Items.
                    giver_ask_id=f"{v}-ask",
                )
            )
    return edges


def random_bundle_circle(seed: int, users: int, wants_per_ask: int) -> list[Edge]:
    """People with up to 2 Asks, overlapping offer sets and several Items each, so legs
    have alternatives and extras: Asks that take up to 3 Items, and other Asks of the
    receiver that the giver's offer set also fills."""
    rng = random.Random(seed)
    names = [f"u{i:03d}" for i in range(users)]
    items = {
        u: [(f"{u}-i{k}", rng.randint(5, 300) * 100) for k in range(rng.randint(2, 5))]
        for u in names
    }
    asks = {u: [f"{u}-a{k}" for k in range(rng.randint(1, 2))] for u in names}
    offers = {
        (u, a): rng.sample(items[u], k=rng.randint(1, len(items[u])))
        for u in names
        for a in asks[u]
    }
    ceiling = {key: rng.choice([0, 0, 1000, 2500, 5000, 20000]) for key in offers}
    takes = {key: rng.choice([1, 1, 2, 3]) for key in offers}
    edges: list[Edge] = []
    for u in names:
        for a in asks[u]:
            for v in rng.sample([x for x in names if x != u], k=min(wants_per_ask, users - 1)):
                b = rng.choice(asks[v])
                for item_id, value in rng.sample(
                    offers[(v, b)], k=rng.randint(1, len(offers[(v, b)]))
                ):
                    edges.append(
                        Edge(
                            from_user=u,
                            to_user=v,
                            item_id=item_id,
                            value_cents=value,
                            cash_ceiling_cents=ceiling[(u, a)],
                            max_items=takes[(u, a)],
                            utility=round(rng.uniform(0.2, 2.0), 2),
                            confidence=round(rng.uniform(0.5, 1.0), 2),
                            kind=rng.choice(["explicit", "explicit", "inferred"]),
                            ask_id=a,
                            giver_ask_id=b,
                        )
                    )
    return edges


def check_rules(req: MatchRequest, res: MatchResponse) -> None:
    known = {(e.from_user, e.to_user, e.item_id, e.ask_id, e.giver_ask_id): e for e in req.edges}
    items_used: Counter[str] = Counter()
    asks_used: Counter[tuple[str, str | None]] = Counter()
    bp = round(req.tolerance_pct * 10_000)

    for deal in res.deals:
        n = len(deal.users)
        assert 2 <= n <= req.max_length
        assert len(set(deal.users)) == n
        if req.anchor_user:
            assert req.anchor_user in deal.users

        # Every Item is a real want: the receiver's Ask wants it, from the giver's offer set.
        gets: dict[str, int] = defaultdict(int)
        gives: dict[str, int] = defaultdict(int)
        given_to: dict[str, set[str]] = defaultdict(set)
        offer_set: dict[str, set[str | None]] = defaultdict(set)
        filled: dict[str, Counter[str | None]] = defaultdict(Counter)
        for leg in deal.item_legs:
            edge = known[(leg.receiver, leg.giver, leg.item_id, leg.ask_id, leg.giver_ask_id)]
            assert leg.value_cents == edge.value_cents
            gets[leg.receiver] += leg.value_cents
            gives[leg.giver] += leg.value_cents
            given_to[leg.giver].add(leg.receiver)
            offer_set[leg.giver].add(leg.giver_ask_id)
            filled[leg.receiver][leg.ask_id] += 1
            items_used[leg.item_id] += 1
        # Everyone gives and gets, each person hands everything to 1 other (a Loop), and
        # no Item appears twice in the Deal.
        assert set(gets) == set(gives) == set(deal.users)
        assert all(len(to) == 1 for to in given_to.values())
        assert len({leg.item_id for leg in deal.item_legs}) == len(deal.item_legs)
        for giver in given_to:
            count = sum(1 for leg in deal.item_legs if leg.giver == giver)
            assert count <= req.max_items_per_leg
            # What each person gives comes from 1 offer set: the one for the Ask the Loop
            # fills for them.
            (main,) = offer_set[giver]
            assert filled[giver][main] >= 1
        for receiver, by_ask in filled.items():
            for ask, count in by_ask.items():
                takes = next(
                    e.max_items for e in req.edges if e.from_user == receiver and e.ask_id == ask
                )
                assert count <= takes
                asks_used[(receiver, ask)] += 1

        # Cash legs add up to each person's cash in and out, and nothing else moves.
        cash_in: dict[str, int] = defaultdict(int)
        cash_out: dict[str, int] = defaultdict(int)
        for c in deal.cash_legs:
            assert c.amount_cents > 0 and c.payer != c.payee
            assert {c.payer, c.payee} <= set(deal.users)
            cash_in[c.payee] += c.amount_cents
            cash_out[c.payer] += c.amount_cents
        assert deal.cash_moved_cents == sum(c.amount_cents for c in deal.cash_legs)

        for f in deal.fairness:
            assert f.gets_cents == gets[f.user] and f.gives_cents == gives[f.user]
            assert f.cash_in_cents - f.cash_out_cents == cash_in[f.user] - cash_out[f.user]
            # Nobody pays over the ceiling of the Ask the Loop fills for them.
            (main,) = offer_set[f.user]
            ceiling = next(
                e.cash_ceiling_cents
                for e in req.edges
                if e.from_user == f.user and e.ask_id == main
            )
            assert cash_out[f.user] <= ceiling
            # Everyone nets within tolerance: max(15% of the larger side, $10).
            expected_tol = max(
                bp * max(f.gets_cents, f.gives_cents) // 10_000, req.tolerance_floor_cents
            )
            assert f.tolerance_cents == expected_tol
            assert f.net_cents == f.gets_cents - f.gives_cents + f.cash_in_cents - f.cash_out_cents
            assert abs(f.net_cents) <= f.tolerance_cents

    # No Item is in 2 Deals, and no Ask is filled by 2.
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


@pytest.mark.parametrize("seed", range(120))
def test_bundle_rules_hold(seed: int):
    rng = random.Random(seed)
    req = MatchRequest(
        edges=random_bundle_circle(seed, users=rng.randint(3, 20), wants_per_ask=rng.randint(1, 4)),
        max_length=rng.choice([2, 3, 4]),
        max_items_per_leg=rng.choice([1, 2, 3]),
        anchor_user=rng.choice([None, "u000"]),
        time_limit_seconds=2,
    )
    check_rules(req, match(req))


def test_bundles_show_up_in_random_circles():
    # Guards against the bundle rules passing only because no Deal ever bundles, and
    # checks they add Deals that 1-for-1 matching can't find.
    bundled = 0
    for seed in range(40):
        edges = random_bundle_circle(seed, users=15, wants_per_ask=3)
        single = match(MatchRequest(edges=edges))
        res = match(MatchRequest(edges=edges, max_items_per_leg=3))
        # Every Loop that balances 1 for 1 still does, so bundles only add.
        assert res.cycles_balanced >= single.cycles_balanced
        bundled += sum(1 for d in res.deals if len(d.item_legs) > len(d.users))
    assert bundled > 0


def test_live_bundle_match_in_a_circle_of_200_is_fast():
    edges = random_bundle_circle(11, users=200, wants_per_ask=6)
    started = time.perf_counter()
    for anchor in ("u000", "u050", "u100", "u150", "u199"):
        req = MatchRequest(edges=edges, anchor_user=anchor, max_items_per_leg=3)
        check_rules(req, match(req))
    per_anchor = (time.perf_counter() - started) / 5
    assert per_anchor < 10, f"{per_anchor:.2f}s per live match"


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
