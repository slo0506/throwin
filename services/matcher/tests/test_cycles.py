from fastapi.testclient import TestClient

from matcher.app import app
from matcher.cycles import find_cycles
from matcher.models import Edge, WantGraph


def e(a: str, b: str, item: str, utility: float = 1.0) -> Edge:
    return Edge(from_user=a, to_user=b, item_id=item, utility=utility)


def test_two_person_swap():
    cycles, _ = find_cycles(WantGraph(edges=[e("a", "b", "b1"), e("b", "a", "a1")]))
    assert [c.users for c in cycles] == [["a", "b"]]
    legs = {(leg.receiver, leg.item_id) for leg in cycles[0].legs}
    assert legs == {("a", "b1"), ("b", "a1")}


def test_three_person_loop_and_no_rotations():
    graph = WantGraph(edges=[e("a", "b", "b1"), e("b", "c", "c1"), e("c", "a", "a1")])
    cycles, _ = find_cycles(graph)
    assert len(cycles) == 1
    assert cycles[0].users == ["a", "b", "c"]


def test_respects_max_length():
    ring = [
        e("a", "b", "1"),
        e("b", "c", "2"),
        e("c", "d", "3"),
        e("d", "e", "4"),
        e("e", "a", "5"),
    ]
    assert find_cycles(WantGraph(edges=ring, max_length=4))[0] == []
    four = ring[:3] + [e("d", "a", "6")]
    assert len(find_cycles(WantGraph(edges=four, max_length=4))[0]) == 1
    assert find_cycles(WantGraph(edges=four, max_length=3))[0] == []


def test_anchor_only_returns_cycles_with_anchor():
    edges = [e("a", "b", "1"), e("b", "a", "2"), e("c", "d", "3"), e("d", "c", "4")]
    cycles, _ = find_cycles(WantGraph(edges=edges, anchor_user="c"))
    assert [c.users for c in cycles] == [["c", "d"]]


def test_prefers_higher_utility_parallel_edge_and_sorts():
    edges = [e("a", "b", "low", 1), e("a", "b", "high", 5), e("b", "a", "x", 1)]
    cycles, _ = find_cycles(WantGraph(edges=edges))
    assert {leg.item_id for leg in cycles[0].legs} == {"high", "x"}


def test_truncation():
    edges = []
    for i in range(6):
        for j in range(6):
            if i != j:
                edges.append(e(str(i), str(j), f"{j}-{i}"))
    cycles, truncated = find_cycles(WantGraph(edges=edges, max_cycles=10))
    assert len(cycles) == 10 and truncated


def test_api():
    client = TestClient(app)
    assert client.get("/healthz").json() == {"status": "ok"}
    res = client.post(
        "/v1/cycles",
        json={
            "edges": [
                {"from_user": "a", "to_user": "b", "item_id": "b1"},
                {"from_user": "b", "to_user": "a", "item_id": "a1"},
            ]
        },
    )
    assert res.status_code == 200
    assert res.json()["cycles"][0]["users"] == ["a", "b"]
