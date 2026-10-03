"""Milestone 3 load test: a synthetic Circle of 200 and live matching against it.

PRD "Done when" for Milestone 3: in a seeded Circle of 200 synthetic users, live matching
returns a Deal in under 10 seconds, and no Item is ever in 2 pending Deals.

This seeds the Circle into a database (users, priced showcase Items, Asks with offer sets,
and embeddings clustered by category so realistic matches exist), then, with --bench, runs
the live path for many askers the way the Prospector does: the circle_want_candidates SQL
function, scoring, the matcher (in process), and stage_deal. It reports timings and checks
that no Item is held by 2 open Deals.

Pointed at a staging Supabase project with the worker running, seeding alone also exercises
the real Prospector end to end: every seeded Ask starts prospecting, which queues a
prospect_ask job. Ask embeddings carry the hash the worker expects, so it uses the synthetic
vectors instead of re-embedding.

Usage (from the repo root):

  uv run --python 3.12 --with 'psycopg[binary]' --with numpy --with pgserver \
      --with-editable services/matcher scripts/loadtest/m3_circle.py --local --bench 50

  # Against a database you already have (applies nothing, only seeds):
  ... scripts/loadtest/m3_circle.py --db "$DATABASE_URL" --bench 50
  ... scripts/loadtest/m3_circle.py --db "$DATABASE_URL" --cleanup

Never run it against a database with real users you care about without --cleanup after:
it creates 200 auth users (loadtest+N@throwin.test).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import statistics
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import psycopg

from matcher.match import match
from matcher.models import Edge, MatchRequest

ROOT = Path(__file__).resolve().parents[2]
MODEL = "voyage-multimodal-3.5"
DIMS = 1024
EMAIL = "loadtest+{}@throwin.test"
CIRCLE_NAME = "Load test Circle"
CATEGORIES = [
    "toys/lego",
    "video_games",
    "sneakers",
    "trading_cards",
    "books",
    "electronics",
    "bags",
    "board_games",
]
# Noise length relative to a unit centroid. Two vectors from the same category land near
# 1 / (1 + NOISE^2) ~ 0.55 cosine, and different categories near 0, roughly the spread real
# Voyage embeddings show between an Ask's words and matching or unrelated Item photos.
NOISE = 0.9
# The Prospector's defaults (services/workers/src/env.ts).
MIN_SIMILARITY = 0.3
CANDIDATES_PER_ASK = 25


def vector_literal(v: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def noisy(rng: np.random.Generator, centroid: np.ndarray) -> np.ndarray:
    noise = rng.standard_normal(DIMS)
    noise *= NOISE / np.linalg.norm(noise)
    v = centroid + noise
    return v / np.linalg.norm(v)


def ask_embedding_hash(target: dict) -> str:
    """The worker's embeddingHash(model, askEmbeddingText(ask)), so it won't re-embed."""
    parts = [target.get("name"), target.get("brand"), target.get("model"), target.get("category")]
    parts += target.get("constraints", [])
    text = ". ".join(p for p in parts if p)
    return hashlib.sha256(f"{MODEL}\n{text}".encode()).hexdigest()


# ---------------------------------------------------------------------------------------------
# Database


def local_database(workdir: Path) -> str:
    """A throwaway Postgres 16 with pgvector and every migration applied."""
    import pgserver

    server = pgserver.get_server(workdir, cleanup_mode="stop")
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        available = {r[0] for r in conn.execute("select name from pg_available_extensions")}
        conn.execute((ROOT / "supabase/tests/shim.sql").read_text())
        for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            sql = path.read_text()
            # pgserver's build has no pgcrypto. The migrations only create it; nothing calls
            # it (gen_random_uuid is built into Postgres 13+).
            if "pgcrypto" not in available:
                sql = sql.replace(
                    "create extension if not exists pgcrypto with schema extensions;", ""
                )
            conn.execute(sql)
    return uri


def cleanup(conn: psycopg.Connection) -> None:
    users = [
        r[0]
        for r in conn.execute(
            "select id from auth.users where email like 'loadtest+%@throwin.test'"
        )
    ]
    if not users:
        print("Nothing to clean up.")
        return
    deals = [
        r[0]
        for r in conn.execute(
            "select distinct deal_id from public.deal_participants where user_id = any(%s)",
            (users,),
        )
    ]
    for deal_id in deals:
        conn.execute("select public.release_deal_items(%s)", (deal_id,))
    conn.execute("delete from public.deals where id = any(%s)", (deals,))
    conn.execute("delete from public.circles where owner_id = any(%s)", (users,))
    conn.execute("delete from auth.users where id = any(%s)", (users,))
    print(f"Removed {len(users)} load-test users, their Circle and {len(deals)} Deals.")


def seed(conn: psycopg.Connection, people: int, seed_value: int) -> dict:
    rng = np.random.default_rng(seed_value)
    pick = random.Random(seed_value)
    centroids = {}
    for category in CATEGORIES:
        c = rng.standard_normal(DIMS)
        centroids[category] = c / np.linalg.norm(c)

    users = [str(uuid.UUID(int=pick.getrandbits(128), version=4)) for _ in range(people)]
    with conn.cursor() as cur:
        cur.executemany(
            "insert into auth.users (id, email, raw_user_meta_data) values (%s, %s, %s)",
            [
                (u, EMAIL.format(i), json.dumps({"first_name": f"Tester {i}"}))
                for i, u in enumerate(users)
            ],
        )
        circle_id = cur.execute(
            "insert into public.circles (name, owner_id) values (%s, %s) returning id",
            (CIRCLE_NAME, users[0]),
        ).fetchone()[0]
        cur.executemany(
            "insert into public.circle_members (circle_id, user_id) values (%s, %s) on conflict do nothing",
            [(circle_id, u) for u in users],
        )

        items, item_vectors, asks, offers, ask_vectors = [], [], [], [], []
        for u in users:
            home = pick.sample(CATEGORIES, k=pick.choice([1, 2]))
            own_items = []
            for k in range(pick.randint(2, 3)):
                category = pick.choice(home)
                mid = pick.randint(15, 300) * 100
                item_id = str(uuid.UUID(int=pick.getrandbits(128), version=4))
                own_items.append(item_id)
                # Narrow ranges, sure identity and a showcase photo score: every Item is
                # showcase, so staged Deals go straight to approvals.
                items.append(
                    (
                        item_id,
                        u,
                        f"Synthetic {category} {k + 1}",
                        category,
                        int(mid * 0.85),
                        mid,
                        int(mid * 1.15),
                    )
                )
                item_vectors.append((item_id, vector_literal(noisy(rng, centroids[category]))))

            wanted = pick.choice([c for c in CATEGORIES if c not in home])
            ask_id = str(uuid.UUID(int=pick.getrandbits(128), version=4))
            target = {
                "kind": "category",
                "name": f"Any {wanted.split('/')[-1].replace('_', ' ')}",
                "brand": None,
                "model": None,
                "category": wanted,
                "constraints": [],
                "anchor": None,
            }
            ceiling = pick.choice([0, 0, 1000, 2500, 5000, 10000])
            asks.append((ask_id, u, target["name"], json.dumps(target), ceiling))
            offers += [(ask_id, item_id) for item_id in own_items]
            ask_vectors.append(
                (ask_id, vector_literal(noisy(rng, centroids[wanted])), ask_embedding_hash(target))
            )

        cur.executemany(
            """insert into public.items (id, owner_id, status, title, category,
                   value_low_cents, value_mid_cents, value_high_cents,
                   identity_conf, condition_conf, photo_score, missing_angles)
               values (%s, %s, 'on_shelf', %s, %s, %s, %s, %s, 0.9, 0.8, 80, '{}')""",
            items,
        )
        cur.executemany(
            "insert into public.item_embeddings (item_id, model, embedding) values (%s, %s, %s::extensions.vector)",
            [(i, MODEL, v) for i, v in item_vectors],
        )
        # Asks start offering so the offer sets don't each queue a job; flipping them to
        # prospecting at the end queues exactly 1 prospect_ask per Ask.
        cur.executemany(
            """insert into public.asks (id, user_id, raw_text, title, target, status, cash_ceiling_cents)
               values (%s, %s, %s, %s, %s, 'offering', %s)""",
            [(a, u, name, name, target, ceiling) for a, u, name, target, ceiling in asks],
        )
        cur.executemany("insert into public.offer_sets (ask_id, item_id) values (%s, %s)", offers)
        cur.executemany(
            """insert into public.ask_embeddings (ask_id, model, embedding, source_hash)
               values (%s, %s, %s::extensions.vector, %s)""",
            [(a, MODEL, v, h) for a, v, h in ask_vectors],
        )
        cur.execute(
            "update public.asks set status = 'prospecting' where id = any(%s)",
            ([a[0] for a in asks],),
        )
    conn.commit()
    print(f"Seeded {people} people, {len(items)} Items and {len(asks)} Asks in Circle {circle_id}.")
    return {"circle_id": circle_id, "users": users}


# ---------------------------------------------------------------------------------------------
# The live path, as the Prospector runs it


def category_top(c: str | None) -> str | None:
    return c.split("/")[0].lower() if c else None


def edges_for(conn: psycopg.Connection, circle_id: str) -> tuple[list[Edge], int]:
    """circle_want_candidates, scored like scoreCandidate in services/workers/src/prospector/
    prospect.ts. The seeded Asks are category Asks with no brand or model, so only the
    category check and the similarity bar apply."""
    rows = conn.execute(
        """select c.ask_id, c.wanter_id, c.cash_ceiling_cents, c.item_id, c.giver_id,
                  c.giver_ask_id, c.similarity, c.category, c.value_mid_cents,
                  a.target ->> 'category'
             from public.circle_want_candidates(%s, %s, %s) c
             join public.asks a on a.id = c.ask_id""",
        (circle_id, MODEL, CANDIDATES_PER_ASK),
    ).fetchall()
    edges = []
    for ask_id, wanter, ceiling, item, giver, giver_ask, sim, category, value, wanted in rows:
        if wanted and category and category_top(wanted) != category_top(category):
            continue
        if sim < MIN_SIMILARITY:
            continue
        score = min(1.0, sim)
        edges.append(
            Edge(
                from_user=str(wanter),
                to_user=str(giver),
                item_id=str(item),
                utility=score,
                confidence=score,
                kind="explicit",
                ask_id=str(ask_id),
                giver_ask_id=str(giver_ask),
                value_cents=value,
                cash_ceiling_cents=ceiling,
            )
        )
    return edges, len(rows)


def stage(conn: psycopg.Connection, deal) -> str:
    row = conn.execute(
        "select public.stage_deal(%s::jsonb, 'live')", (deal.model_dump_json(),)
    ).fetchone()[0]
    conn.commit()
    return row["result"]


def bench(
    uri: str,
    conn: psycopg.Connection,
    circle_id: str,
    users: list[str],
    askers: int,
    parallel: int,
    seed_value: int,
) -> bool:
    """Runs askers through the live path, `parallel` at a time on separate connections, the
    way several worker lanes race to stage Deals over the same Items."""
    pick = random.Random(seed_value + 1)
    lock = threading.Lock()
    timings: list[float] = []
    parts: dict[str, list[float]] = {"candidates": [], "match": [], "stage": []}
    counts = {"staged": 0, "with_deal": 0, "candidates": 0, "edges": 0}
    refused: dict[str, int] = {}
    local = threading.local()

    def run(anchor: str) -> None:
        if not hasattr(local, "conn"):
            local.conn = psycopg.connect(uri)
        c = local.conn
        t0 = time.perf_counter()
        edges, candidates = edges_for(c, circle_id)
        c.commit()
        t1 = time.perf_counter()
        result = match(MatchRequest(edges=edges, anchor_user=anchor, time_limit_seconds=5))
        t2 = time.perf_counter()
        outcomes = [stage(c, deal) for deal in result.deals]
        t3 = time.perf_counter()
        with lock:
            timings.append(t3 - t0)
            parts["candidates"].append(t1 - t0)
            parts["match"].append(t2 - t1)
            parts["stage"].append(t3 - t2)
            counts["with_deal"] += bool(result.deals)
            counts["candidates"], counts["edges"] = candidates, len(edges)
            for outcome in outcomes:
                if outcome == "ok":
                    counts["staged"] += 1
                else:
                    refused[outcome] = refused.get(outcome, 0) + 1

    with ThreadPoolExecutor(max_workers=parallel) as pool:
        list(pool.map(run, pick.sample(users, k=min(askers, len(users)))))
    staged, with_deal, candidates = counts["staged"], counts["with_deal"], counts["candidates"]
    edges = [None] * counts["edges"]

    timings.sort()
    p95 = timings[max(0, int(len(timings) * 0.95) - 1)]
    print(
        f"\nLive matching for {len(timings)} askers, {parallel} at a time (last run: {candidates} candidates, {len(edges)} edges)"
    )
    print(
        f"  per asker: median {statistics.median(timings):.2f}s, p95 {p95:.2f}s, max {timings[-1]:.2f}s"
    )
    for name, values in parts.items():
        print(
            f"    {name:<10} median {statistics.median(values) * 1000:.0f} ms, max {max(values) * 1000:.0f} ms"
        )
    print(
        f"  askers with a Deal: {with_deal}; Deals staged: {staged}; refused at staging: {refused or 'none'}"
    )

    doubled = conn.execute(
        """select dl.item_id, count(*) from public.deal_legs dl
             join public.deals d on d.id = dl.deal_id
            where d.status in ('staged', 'pending_approvals') and dl.item_id is not null
            group by 1 having count(*) > 1"""
    ).fetchall()
    stray = conn.execute(
        """select count(*) from public.items i
            where i.reserved_by_deal_id is not null
              and not exists (select 1 from public.deals d
                               where d.id = i.reserved_by_deal_id
                                 and d.status in ('staged', 'pending_approvals'))"""
    ).fetchone()[0]

    fast = timings[-1] < 10
    print("\nPRD Milestone 3 checks")
    print(f"  {'PASS' if fast else 'FAIL'}  every live match under 10 s (max {timings[-1]:.2f}s)")
    print(f"  {'PASS' if not doubled else 'FAIL'}  no Item in 2 open Deals ({len(doubled)} found)")
    print(
        f"  {'PASS' if stray == 0 else 'FAIL'}  every held Item belongs to an open Deal ({stray} stray)"
    )
    print(f"  {'PASS' if staged > 0 else 'FAIL'}  matching produced Deals ({staged})")
    return fast and not doubled and stray == 0 and staged > 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--local", action="store_true", help="throwaway local Postgres (pgserver)")
    where.add_argument("--db", help="a Postgres URL, e.g. a staging project's direct connection")
    parser.add_argument("--people", type=int, default=200)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--bench",
        type=int,
        default=0,
        metavar="ASKERS",
        help="run live matching for this many askers",
    )
    parser.add_argument(
        "--parallel", type=int, default=1, help="askers matched at once, like worker lanes"
    )
    parser.add_argument(
        "--cleanup", action="store_true", help="remove everything a previous run seeded, then exit"
    )
    args = parser.parse_args()

    workdir = Path(tempfile.mkdtemp(prefix="throwin-loadtest-"))
    uri = local_database(workdir) if args.local else args.db
    with psycopg.connect(uri) as conn:
        if args.cleanup:
            cleanup(conn)
            conn.commit()
            return 0
        if conn.execute(
            "select 1 from auth.users where email like 'loadtest+%@throwin.test' limit 1"
        ).fetchone():
            print("This database already has load-test users. Run with --cleanup first.")
            return 1
        seeded = seed(conn, args.people, args.seed)
        if args.bench:
            ok = bench(
                uri,
                conn,
                seeded["circle_id"],
                seeded["users"],
                args.bench,
                args.parallel,
                args.seed,
            )
            return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
