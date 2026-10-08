# Setup

## Accounts

| Service | What for | Status |
| --- | --- | --- |
| GitHub | Repo, PRs, CI | Connect GitHub in claude.ai, then create the `throwin` repo |
| Supabase | Postgres, auth, storage, realtime | `throwin-dev` is live (ref `uhxzajdmerqubbkqhlxe`, us-west-1, in the Crews org) with every migration applied. Create `throwin-staging` before Milestone 3. |
| Railway | Hosts `api`, `harness`, `workers`, `matcher` | `api` is live at https://throwinapi-production.up.railway.app (project `zesty-consideration`). Each service's build is set in its Railway settings: Dockerfile path `services/<name>/Dockerfile`, a start command, and watch paths. There is no `railway.json` (Railway deprecated config-as-code, and a root file applies to every service). `matcher` (us-west2) builds with root directory `/services/matcher`, Dockerfile `Dockerfile`, health check `/healthz`, and has no public domain: `workers` reaches it at `MATCHER_URL=http://matcher.railway.internal:8080` over the private network, and logs `matcher_reachable` at startup. |
| Anthropic | Claude API for the GM and workers | Needed from Milestone 1 |
| Voyage AI | Item embeddings (`voyage-multimodal-3.5`) | Needed from Milestone 1 |
| Stripe | Throw-Ins through Connect, test mode first | Needed in Milestone 4 |
| Apple Developer | Sign in with Apple, push, App Attest, TestFlight | Enroll before Milestone 2 |

Keys for Anthropic, Voyage, Stripe and the Supabase service role live only in Railway's secret store, never in the app or in git.

## Environment variables (`services/api`)

| Variable | Where it comes from |
| --- | --- |
| `SUPABASE_URL` | Supabase project settings, API |
| `SUPABASE_ANON_KEY` | Supabase project settings, API keys (publishable) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project settings, API keys (secret). Server only. |
| `SUPABASE_JWT_SECRET` or `SUPABASE_JWKS_URL` | Supabase project settings, JWT keys |
| `APP_ATTEST_MODE` | `off` locally, `log` in staging, `enforce` in prod |
| `PORT` | Defaults to 8787 |
| `BRAVE_SEARCH_API_KEY` | Optional. [Brave Search API](https://api-search.brave.com) key, for product photos on Ask cards. Without it, only images on pages the GM cited are tried, and most retail sites block those. Server only. |
| `GM_USER_DAILY_BUDGET_CENTS`, `GM_DAILY_BUDGET_CENTS` | Optional. GM chat spend caps; see "Spend caps". |
| `MATCHER_URL` | The matcher over Railway's private network, `http://matcher.railway.internal:8080`, the same as `workers`. Counters re-balance through it; without it, counters answer 503 and the rest of the API works. |

## Spend caps

Every model call is recorded in `agent_runs` with its cost, so everything that spends has a hard cap, counted over the last 24 hours. To change a cap, set the variable in Railway for that service; it applies when the service restarts.

| What | Variable (service) | Default | When it's reached |
| --- | --- | --- | --- |
| Background agents: Appraiser, Refiner, memory, Prospector | `WORKER_DAILY_BUDGET_CENTS` (`workers`) | 500 ($5 a day) | Jobs wait in the queue and run once the window frees up. The worker logs `budget_exhausted`. |
| GM chat, per person | `GM_USER_DAILY_BUDGET_CENTS` (`api`) | 300 ($3 a day) | The app says "You've reached today's limit with your GM." |
| GM chat, everyone together | `GM_DAILY_BUDGET_CENTS` (`api`) | 1000 ($10 a day) | Every GM pauses ("Your GM is taking a break"), and the API logs `gm_budget_reached`. |
| 1 eval run | `--max-cents` (`eval:gm`, `eval:review`, `eval:appraisal`) | 200 ($2) | The run stops and exits as failed. |

What things cost so far (Oct 2026, 1 to 3 testers): about 40 cents a day of background work and 60 to 75 cents a day of GM chat, with about $6 of background work on the heaviest day. Pricing an Item costs about 12 cents and identifying a capture about 2. A GM turn averages about 1.5 cents, and looking up a product from a photo or link about 8.

A turn or job that starts under a cap can finish a little over it, by about 1 turn or a minute of jobs. Voyage embeddings aren't capped; they cost a fraction of a cent per Item. There are no scheduled eval runs (decided Oct 7, 2026). As a last line of defense, also set a monthly spend limit on the Anthropic workspace in the Anthropic Console.

## Local development

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test      # TypeScript
cd services/matcher && pip install -e ".[dev]" && pytest   # Python matcher
./scripts/check-migrations.sh                 # Migrations, seed and RLS tests on a throwaway Postgres
pnpm --filter @throwin/api dev                # API on :8787 (needs services/api/.env)
```

iOS: see `apps/ios/README.md`.

## Migrations

`throwin-dev` was set up through the Supabase connector, so its migration history uses the connector's timestamps. Before the first `supabase db push` against it, run `supabase migration repair` to mark the 6 local migrations as applied.

Migrations live in `supabase/migrations/` and are tested by `scripts/check-migrations.sh` in CI. To apply them to a hosted project:

```sh
supabase link --project-ref <ref>
supabase db push
```
