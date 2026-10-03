"""Bounded cycle search over the want graph.

A cycle A -> B -> C -> A means A receives from B, B receives from C, and C receives from A.
Like a kidney exchange, we only look at short cycles (2 to 4 people), because every extra
person is another handoff and another approval that can fail.

A node is 1 person's Ask, not the person: an offer set belongs to 1 Ask, so what someone
gives in a cycle must come from the offer set of the Ask the cycle fills for them. An edge
runs from the wanter's Ask (`ask_id`) to the giver's Ask whose offer set holds the Item
(`giver_ask_id`). A person still appears at most once per cycle.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator

from .models import Cycle, Edge, Leg, WantGraph

# (user, ask_id or ""): edges with no Ask meet at the person's "" node.
Node = tuple[str, str]


def _from(e: Edge) -> Node:
    return (e.from_user, e.ask_id or "")


def _to(e: Edge) -> Node:
    return (e.to_user, e.giver_ask_id or "")


def _best_edges(edges: list[Edge]) -> dict[Node, dict[Node, Edge]]:
    """Collapse parallel edges: for each (wanter Ask, giver Ask) pair keep the most useful."""
    best: dict[Node, dict[Node, Edge]] = defaultdict(dict)
    for e in edges:
        if e.from_user == e.to_user:
            continue
        a, b = _from(e), _to(e)
        current = best[a].get(b)
        if current is None or (e.utility * e.confidence) > (current.utility * current.confidence):
            best[a][b] = e
    return best


def _canonical(path: list[Node]) -> tuple[Node, ...]:
    """Rotate a cycle so its smallest node comes first, so rotations dedupe."""
    i = path.index(min(path))
    return tuple(path[i:] + path[:i])


def iter_cycles(graph: WantGraph) -> Iterator[list[Node]]:
    adj = _best_edges(graph.edges)
    if graph.anchor_user:
        starts = sorted(n for n in adj if n[0] == graph.anchor_user)
    else:
        starts = sorted(adj)
    seen: set[tuple[Node, ...]] = set()

    for start in starts:
        stack: list[tuple[Node, list[Node]]] = [(start, [start])]
        while stack:
            node, path = stack.pop()
            for nxt in sorted(adj[node]):
                if nxt == start and len(path) >= 2:
                    key = _canonical(path)
                    if key not in seen:
                        seen.add(key)
                        yield list(key)
                    continue
                if len(path) >= graph.max_length or any(nxt[0] == n[0] for n in path):
                    continue
                # In drop mode, only extend through nodes "after" the start, which visits
                # each cycle from its smallest node once and keeps the search bounded.
                if graph.anchor_user is None and nxt < start:
                    continue
                stack.append((nxt, [*path, nxt]))


def find_cycle_edges(graph: WantGraph) -> tuple[list[list[Edge]], bool]:
    """Each cycle as its edges in order: edge i is what the i-th person receives."""
    adj = _best_edges(graph.edges)
    found: list[list[Edge]] = []
    for nodes in iter_cycles(graph):
        if len(found) >= graph.max_cycles:
            return found, True
        n = len(nodes)
        found.append([adj[nodes[i]][nodes[(i + 1) % n]] for i in range(n)])
    return found, False


def find_cycles(graph: WantGraph) -> tuple[list[Cycle], bool]:
    found, truncated = find_cycle_edges(graph)
    cycles = [
        Cycle(
            users=[e.from_user for e in edges],
            legs=[Leg(giver=e.to_user, receiver=e.from_user, item_id=e.item_id) for e in edges],
            utility=sum(e.utility for e in edges),
            min_confidence=min(e.confidence for e in edges),
        )
        for edges in found
    ]
    cycles.sort(key=lambda c: (-c.utility, len(c.users)))
    return cycles, truncated
