# Setup

## Accounts

| Service | What for | Status |
| --- | --- | --- |
| GitHub | Repo, PRs, CI | Connect GitHub in claude.ai, then create the `throwin` repo |
| Supabase | Postgres, auth, storage, realtime | `throwin-dev` is live (ref `uhxzajdmerqubbkqhlxe`, us-west-1, in the Crews org) with every migration applied. Create `throwin-staging` before Milestone 3. |
| Railway | Hosts `api`, `harness`, `workers`, `matcher` | Needed from Milestone 1 |
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
