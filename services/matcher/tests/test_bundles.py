"""Bundles (X for Y): a person can hand another several Items from 1 offer set, when cash
alone can't even the trade out, and only Items the receiver's Asks want."""

from matcher.balance import balance_bundle
from matcher.match import match
from matcher.models import Edge, MatchRequest


def e(
    wanter: str,
    giver: str,
    item: str,
    value: int,
    ask: str,
    giver_ask: str,
    ceiling: int = 0,
    max_items: int = 1,
    utility: float = 1.0,
) -> Edge:
    return Edge(
        from_user=wanter,
        to_user=giver,
        item_id=item,
        value_cents=value,
        ask_id=ask,
        giver_ask_id=giver_ask,
        cash_ceiling_cents=ceiling,
        max_items=max_items,
        utility=utility,
    )


def console_for_games(a_ceiling: int, b_takes: int) -> list[Edge]:
    """a wants b's $150 Switch; b wants Switch games and a offers 3 at $40 each."""
    return [
        e("a", "b", "switch", 15000, "a-switch", "b-games", ceiling=a_ceiling),
        *(
            e("b", "a", g, 4000, "b-games", "a-switch", max_items=b_takes, utility=u)
            for g, u in (("zelda", 0.9), ("mario", 0.8), ("kirby", 0.7))
        ),
    ]


def legs_of(deal) -> list[tuple[str, str, str]]:
    return [(leg.giver, leg.receiver, leg.item_id) for leg in deal.item_legs]


# balance_bundle -----------------------------------------------------------------------------


def test_adds_items_when_cash_cant_even_it_out():
    edges = console_for_games(a_ceiling=1000, b_takes=3)
    switch, *games = edges
    # 1 game: a would owe b $87.50, over a's $10 ceiling. 3 games: a owes $7.50.
    b = balance_bundle([[switch], games], 0.15, 1000, max_items_per_leg=3)
    assert b is not None
    assert [x.item_id for x in b.legs[1]] == ["zelda", "mario", "kirby"]
    assert [(c.payer, c.payee, c.amount_cents) for c in b.cash_legs] == [("a", "b", 750)]
    a, bb = b.fairness
    assert (a.gets_cents, a.gives_cents, a.net_cents, a.tolerance_cents) == (
        15000,
        12000,
        2250,
        2250,
    )
    assert (bb.gets_cents, bb.gives_cents, bb.net_cents) == (12000, 15000, -2250)


def test_adds_as_few_items_as_it_can_before_saving_cash():
    switch, *games = console_for_games(a_ceiling=5000, b_takes=3)
    # 2 games and $47.50 beat 3 games and $7.50: fewer Items first.
    b = balance_bundle([[switch], games], 0.15, 1000, max_items_per_leg=3)
    assert b is not None
    assert [x.item_id for x in b.legs[1]] == ["zelda", "mario"]
    assert b.cash_moved_cents == 4750


def test_an_ask_that_takes_1_item_never_gets_2():
    switch, *games = console_for_games(a_ceiling=1000, b_takes=1)
    assert balance_bundle([[switch], games], 0.15, 1000, max_items_per_leg=3) is None


def test_the_leg_cap_holds():
    switch, *games = console_for_games(a_ceiling=1000, b_takes=3)
    assert balance_bundle([[switch], games], 0.15, 1000, max_items_per_leg=2) is None


def test_swaps_to_an_item_that_balances_without_extras():
    # a's best game is $40, but a also offers a $140 one: 1 Item each way, no cash.
    switch = e("a", "b", "switch", 15000, "a-switch", "b-games")
    cheap = e("b", "a", "zelda", 4000, "b-games", "a-switch", utility=0.9)
    pricey = e("b", "a", "bundle", 14000, "b-games", "a-switch", utility=0.6)
    b = balance_bundle([[switch], [cheap, pricey]], 0.15, 1000, max_items_per_leg=1)
    assert b is not None
    assert [x.item_id for x in b.legs[1]] == ["bundle"]
    assert b.cash_legs == []


def test_extras_can_fill_the_receivers_other_ask():
    # b wants a Switch game and, separately, vintage Nike. a offers both for the Switch.
    switch = e("a", "b", "switch", 15000, "a-switch", "b-games")
    zelda = e("b", "a", "zelda", 4000, "b-games", "a-switch")
    jacket = e("b", "a", "nike-jacket", 9000, "b-nike", "a-switch")
    b = balance_bundle([[switch], [zelda, jacket]], 0.15, 1000, max_items_per_leg=2)
    assert b is not None
    assert [(x.item_id, x.ask_id) for x in b.legs[1]] == [
        ("zelda", "b-games"),
        ("nike-jacket", "b-nike"),
    ]
    assert b.cash_legs == []


def test_every_person_still_gets_an_item_for_the_cycles_ask():
    # The $150 Nike jacket alone would even it out, but b's Ask in this Loop is the Switch
    # game, so b must get 1. Game and jacket put b $40 ahead, over the $28.50 tolerance,
    # and b can't add cash.
    switch = e("a", "b", "switch", 15000, "a-switch", "b-games")
    zelda = e("b", "a", "zelda", 4000, "b-games", "a-switch")
    jacket = e("b", "a", "nike-jacket", 15000, "b-nike", "a-switch")
    assert balance_bundle([[switch], [zelda, jacket]], 0.15, 1000, max_items_per_leg=2) is None


# match --------------------------------------------------------------------------------------


def test_one_for_one_by_default():
    res = match(MatchRequest(edges=console_for_games(a_ceiling=1000, b_takes=3)))
    assert res.deals == []
    res = match(MatchRequest(edges=console_for_games(a_ceiling=10_000, b_takes=3)))
    (deal,) = res.deals
    assert legs_of(deal) == [("b", "a", "switch"), ("a", "b", "zelda")]


def test_a_bundle_deal_lists_every_item_and_sums_the_sides():
    req = MatchRequest(edges=console_for_games(a_ceiling=1000, b_takes=3), max_items_per_leg=3)
    (deal,) = match(req).deals
    assert legs_of(deal) == [
        ("b", "a", "switch"),
        ("a", "b", "zelda"),
        ("a", "b", "mario"),
        ("a", "b", "kirby"),
    ]
    assert {f.user: (f.gives_cents, f.gets_cents) for f in deal.fairness} == {
        "a": (12000, 15000),
        "b": (15000, 12000),
    }
    # Utility of all 4 Items, minus 2 extra Items and $7.50 of cash on $270 of Items.
    assert deal.score == round(1.0 + 0.9 + 0.8 + 0.7 - 2 * 0.15 - 750 / 27000, 3)


def test_bundles_work_in_a_3_way_loop():
    # a wants c's lamp, c wants b's console, b wants a's games (takes up to 2).
    edges = [
        e("a", "c", "lamp", 15000, "a-lamp", "c-console", ceiling=0),
        e("c", "b", "console", 15000, "c-console", "b-games"),
        e("b", "a", "zelda", 7000, "b-games", "a-lamp", max_items=2),
        e("b", "a", "mario", 7500, "b-games", "a-lamp", max_items=2),
    ]
    (deal,) = match(MatchRequest(edges=edges, max_items_per_leg=2)).deals
    assert sorted(legs_of(deal)) == [
        ("a", "b", "mario"),
        ("a", "b", "zelda"),
        ("b", "c", "console"),
        ("c", "a", "lamp"),
    ]
    assert deal.cash_legs == []


def test_an_extra_ask_counts_as_filled():
    # b's Nike Ask is filled by the bundle, so a second Deal can't fill it too.
    edges = [
        e("a", "b", "switch", 15000, "a-switch", "b-games"),
        e("b", "a", "zelda", 4000, "b-games", "a-switch"),
        e("b", "a", "nike-jacket", 9000, "b-nike", "a-switch"),
        # c would also fill b's Nike Ask, for b's other Item.
        e("c", "b", "tee", 3000, "c-tee", "b-nike", utility=0.5),
        e("b", "c", "nike-cap", 3000, "b-nike", "c-tee", utility=0.5),
    ]
    res = match(MatchRequest(edges=edges, max_items_per_leg=2))
    asks = [(leg.receiver, leg.ask_id) for d in res.deals for leg in d.item_legs]
    assert asks.count(("b", "b-nike")) <= 1
    assert len(res.deals) == 1
