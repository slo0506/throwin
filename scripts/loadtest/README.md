# Load tests

## `m3_circle.py`: the Milestone 3 "Done when"

> In a seeded staging Circle of 200 synthetic users, live matching returns a Deal in under 10 seconds, no Item is ever in 2 pending Deals.

The script seeds a synthetic Circle into a database:
- 200 people
- 2 to 3 priced, showcase Items each
- 1 category Ask each, with its offer set
- embeddings clustered by category, so matches exist the way they would for real

With `--bench`, it then runs live matching the way the Prospector does: `circle_want_candidates`, scoring, the matcher (in process) and `stage_deal`. It prints timings and the PRD checks.

```sh
UV=uv   # or "$(python3 -m site --user-base)/bin/uv"
$UV run --python 3.12 --with 'psycopg[binary]' --with numpy --with pgserver \
  --with-editable services/matcher scripts/loadtest/m3_circle.py --local --bench 200 --parallel 8
```

- `--local` starts a throwaway Postgres 16 with pgvector (the `pgserver` package, no install needed) and applies every migration.
- `--db <url>` seeds an existing database instead. Point it at a staging project's direct connection string. With the worker running there, seeding alone also runs the real Prospector: every seeded Ask starts prospecting and queues a `prospect_ask` job. The Ask embeddings carry the hash the worker expects, so it uses the synthetic vectors instead of calling Voyage.
- `--parallel N` matches N askers at once on separate connections, like worker lanes racing to stage Deals over the same Items.
- `--cleanup` removes everything a run seeded (users `loadtest+N@throwin.test`, their Circle and Deals). Run it after any `--db` run, and don't point this at a database whose real users you care about.

### Results (Oct 3, 2026, MacBook, local Postgres)

| Run | Median | p95 | Worst | Deals | Double-booked Items |
| --- | --- | --- | --- | --- | --- |
| 50 askers, 1 at a time | 0.30 s | 0.64 s | 0.69 s | 35 staged | 0 |
| 200 askers, 8 at a time | 0.36 s | 3.97 s | 5.95 s | 41 staged, 17 refused (`ask_unavailable`: another asker's Deal got there first) | 0 |

Most of the time goes to `circle_want_candidates`. It scores every prospecting Ask in the Circle on each run (about 350 ms for 200 people), and slows down when many runs overlap. That's fine at pilot size. It's the first thing to optimize if Circles grow well past 200, for example by reusing stored `edges` for Asks that haven't changed.
