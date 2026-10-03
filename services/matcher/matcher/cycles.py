"""Bounded cycle search over the want graph.

A cycle A -> B -> C -> A means A receives from B, B receives from C, and C receives from A.
Like a kidney exchange, we only look at short cycles (2 to 4 people), because every extra
person is another handoff and another approval that can fail.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator

from .models import Cycle, Edge, Leg, WantGraph


def _best_edges(edges: list[Edge]) -> dict[str, dict[str, Edge]]:
    """Collapse parallel edges: for each (wanter, giver) pair keep the most useful Item."""
    best: dict[str, dict[str, Edge]] = defaultdict(dict)
    for e in edges:
        if e.from_user == e.to_user:
            continue
        current = best[e.from_user].get(e.to_user)
        if current is None or (e.utility * e.confidence) > (current.utility * current.confidence):
            best[e.from_user][e.to_user] = e
    return best


def _canonical(path: list[str]) -> tuple[str, ...]:
    """Rotate a cycle so its smallest user ID comes first, so rotations dedupe."""
    i = path.index(min(path))
    return tuple(path[i:] + path[:i])


def iter_cycles(graph: WantGraph) -> Iterator[list[str]]:
    adj = _best_edges(graph.edges)
    starts = [graph.anchor_user] if graph.anchor_user else sorted(adj)
    seen: set[tuple[str, ...]] = set()

    for start in starts:
        if start not in adj:
            continue
        stack: list[tuple[str, list[str]]] = [(start, [start])]
        while stack:
            node, path = stack.pop()
            for nxt in sorted(adj[node]):
                if nxt == start and len(path) >= 2:
                    key = _canonical(path)
                    if key not in seen:
                        seen.add(key)
                        yield list(key)
                    continue
                if nxt in path or len(path) >= graph.max_length:
                    continue
                # In drop mode, only extend through users "after" the start, which visits
                # each cycle from its smallest member once and keeps the search bounded.
                if graph.anchor_user is None and nxt < start:
                    continue
                stack.append((nxt, [*path, nxt]))


def find_cycle_edges(graph: WantGraph) -> tuple[list[list[Edge]], bool]:
    """Each cycle as its edges in user order: edge i is what users[i] receives."""
    adj = _best_edges(graph.edges)
    found: list[list[Edge]] = []
    for users in iter_cycles(graph):
        if len(found) >= graph.max_cycles:
            return found, True
        n = len(users)
        found.append([adj[users[i]][users[(i + 1) % n]] for i in range(n)])
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
