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


def find_cycles(graph: WantGraph) -> tuple[list[Cycle], bool]:
    adj = _best_edges(graph.edges)
    cycles: list[Cycle] = []
    truncated = False
    for users in iter_cycles(graph):
        if len(cycles) >= graph.max_cycles:
            truncated = True
            break
        n = len(users)
        legs: list[Leg] = []
        utility = 0.0
        min_conf = 1.0
        for i, receiver in enumerate(users):
            giver = users[(i + 1) % n]
            edge = adj[receiver][giver]
            legs.append(Leg(giver=giver, receiver=receiver, item_id=edge.item_id))
            utility += edge.utility
            min_conf = min(min_conf, edge.confidence)
        cycles.append(Cycle(users=users, legs=legs, utility=utility, min_confidence=min_conf))
    cycles.sort(key=lambda c: (-c.utility, len(c.users)))
    return cycles, truncated
