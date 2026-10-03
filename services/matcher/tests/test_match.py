from fastapi.testclient import TestClient

from matcher.app import app
from matcher.balance import balance
from matcher.match import match
from matcher.models import Edge, MatchRequest


def e(
    wanter: str,
    giver: str,
    item: str,
    value: int,
    ceiling: int = 0,
    utility: float = 1.0,
    ask: str | None = None,
    **kw,
) -> Edge:
    return Edge(
        from_user=wanter,
        to_user=giver,
        item_id=item,
        value_cents=value,
        cash_ceiling_cents=ceiling,
        utility=utility,
        ask_id=ask,
        **kw,
    )


# balance ----------------------------------------------------------------------------------


def test_even_swap_needs_no_cash():
    # a gets b's $50 game, b gets a's $55 game: $5 apart, inside the $10 floor.
    b = balance([e("a", "b", "b1", 5000), e("b", "a", "a1", 5500)], 0.15, 1000)
    assert b is not None
    assert b.cash_legs == [] and b.cash_moved_cents == 0
    assert {f.user: f.net_cents for f in b.fairness} == {"a": -500, "b": 500}


def test_uneven_swap_adds_the_smallest_throw_in():
    # a gets a $200 Batmobile for a $150 set. Tolerance is 15% of $200 = $30, so a pays $20.
    b = balance([e("a", "b", "bat", 20000, ceiling=5000), e("b", "a", "set", 15000)], 0.15, 1000)
    assert b is not None
    assert [(c.payer, c.payee, c.amount_cents) for c in b.cash_legs] == [("a", "b", 2000)]
    a, bb = sorted(b.fairness, key=lambda f: f.user)
    assert (a.cash_out_cents, a.net_cents, a.tolerance_cents) == (2000, 3000, 3000)
    assert (bb.cash_in_cents, bb.net_cents) == (2000, -3000)


def test_cash_ceiling_too_low_drops_the_cycle():
    edges = [e("a", "b", "bat", 20000, ceiling=1000), e("b", "a", "set", 15000)]
    assert balance(edges, 0.15, 1000) is None


def test_only_the_person_coming_out_ahead_pays():
    # b would gladly pay but is behind; only a, who is ahead, can close the gap.
    edges = [e("a", "b", "bat", 20000), e("b", "a", "set", 15000, ceiling=100_000)]
    assert balance(edges, 0.15, 1000) is None


def test_three_person_loop_settles_with_transfers():
    # a gets b's $300 Item for a $100 one, b gets $100 for $300, c gets $100 for $100.
    edges = [
        e("a", "b", "b1", 30000, ceiling=20000),
        e("b", "c", "c1", 10000),
        e("c", "a", "a1", 10000),
    ]
    b = balance(edges, 0.15, 1000)
    assert b is not None
    assert sum(f.cash_in_cents - f.cash_out_cents for f in b.fairness) == 0
    for f in b.fairness:
        assert abs(f.net_cents) <= f.tolerance_cents
    # a is $200 ahead and b $200 behind; tolerance is 15% of $300 = $45, so a pays b $155.
    assert [(c.payer, c.payee, c.amount_cents) for c in b.cash_legs] == [("a", "b", 15500)]


# match ------------------------------------------------------------------------------------


def test_no_item_is_promised_twice():
    # 2 swaps both want b's Batmobile; only the better one can happen.
    req = MatchRequest(
        edges=[
            e("a", "b", "bat", 5000, utility=3),
            e("b", "a", "a1", 5000),
            e("c", "b", "bat", 5000, utility=1),
            e("b", "c", "c1", 5000),
        ]
    )
    res = match(req)
    assert res.cycles_found == 2 and res.cycles_balanced == 2
    assert [d.users for d in res.deals] == [["a", "b"]]
    assert res.optimal


def test_an_ask_is_filled_once():
    # a's 1 Ask could be filled by b or by c; a gives different Items in each.
    req = MatchRequest(
        edges=[
            e("a", "b", "b1", 5000, ask="ask-a", utility=2),
            e("b", "a", "a1", 5000),
            e("a", "c", "c1", 5000, ask="ask-a", utility=1),
            e("c", "a", "a2", 5000),
        ]
    )
    res = match(req)
    assert [d.users for d in res.deals] == [["a", "b"]]


def test_picks_2_small_deals_over_1_that_blocks_both():
    edges = [
        # A 3-way using x, y, z.
        e("a", "b", "x", 5000, utility=2),
        e("b", "c", "y", 5000, utility=2),
        e("c", "a", "z", 5000, utility=2),
        # 2 swaps, one using x and one using y, worth more together.
        e("a", "b", "x", 5000, utility=0),
        e("b", "a", "w", 5000, utility=4),
        e("d", "c", "y", 5000, utility=4),
        e("c", "d", "v", 5000, utility=4),
    ]
    res = match(MatchRequest(edges=edges))
    picked = sorted(tuple(d.users) for d in res.deals)
    assert ("a", "b", "c") not in picked
    assert len(picked) == 2


def test_inferred_and_low_confidence_edges_cost_score():
    sure = match(MatchRequest(edges=[e("a", "b", "1", 5000), e("b", "a", "2", 5000)]))
    unsure = match(
        MatchRequest(
            edges=[
                e("a", "b", "1", 5000, kind="inferred", confidence=0.6),
                e("b", "a", "2", 5000),
            ]
        )
    )
    assert sure.deals[0].score == 2.0
    assert unsure.deals[0].score == 2.0 - 0.4 - 0.3


def test_worthless_cycles_are_not_proposed():
    res = match(
        MatchRequest(edges=[e("a", "b", "1", 5000, utility=0), e("b", "a", "2", 5000, utility=0)])
    )
    assert res.cycles_balanced == 1 and res.deals == []


def test_match_api():
    res = TestClient(app).post(
        "/v1/match",
        json={
            "anchor_user": "a",
            "edges": [
                {
                    "from_user": "a",
                    "to_user": "b",
                    "item_id": "bat",
                    "value_cents": 20000,
                    "cash_ceiling_cents": 5000,
                    "utility": 1,
                    "ask_id": "ask-a",
                },
                {"from_user": "b", "to_user": "a", "item_id": "set", "value_cents": 15000},
            ],
        },
    )
    assert res.status_code == 200
    deal = res.json()["deals"][0]
    assert deal["cash_legs"] == [{"payer": "a", "payee": "b", "amount_cents": 2000}]
    assert deal["item_legs"][0] == {
        "giver": "b",
        "receiver": "a",
        "item_id": "bat",
        "value_cents": 20000,
        "ask_id": "ask-a",
        "kind": "explicit",
    }
