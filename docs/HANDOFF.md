# Throw-In: handoff (as of Oct 3, 2026, 1:30 PM PT)

Read `CLAUDE.md` first, then `docs/prd.md` (product spec), `docs/design.md` (design system) and `docs/contracts/m2-gm-and-asks.md` (Milestone 2 API contract). `main` is at `9cb3e2e` and CI is green.

## Architecture

| Part | Where | Stack | Hosting |
| --- | --- | --- | --- |
| iOS app | `apps/ios` | SwiftUI, Swift 6 (default MainActor), iOS 26 Liquid Glass, Metal shaders | Xcode on Sean's Mac, Simulator iPhone 17 Pro |
| API | `services/api` | TypeScript, Hono, zod, jose (Supabase ES256 JWTs) | Railway service `@throwin/api`, https://throwinapi-production.up.railway.app |
| GM harness | `services/harness` (`@throwin/harness`) | Agent loop on the Messages API, tools, SSE | Runs inside the API process (not its own service) |
| Workers | `services/workers` | Postgres job queue (`claim_job`, SKIP LOCKED), 4 lanes | Railway service `workers` |
| Matcher | `services/matcher` | Python, FastAPI, cycle search | Not deployed yet (Milestone 3) |
| Database | `supabase/migrations` | Supabase Postgres 17, pgvector, RLS on every table, private bucket `item-media` | Supabase project `throwin-dev` (`uhxzajdmerqubbkqhlxe`, us-west-1) |
| Evals | `evals/cases`, `evals/runner` | JSON cases, vitest, real-model runners | Run locally only, never in CI |
| Shared types | `packages/shared` | zod schemas for API, readiness, Asks, GM | |

**Railway:** project `zesty-consideration` (`7c9cca4a-255c-4de8-a339-f00a1dad551b`). Services deploy automatically on push to `main` (Dockerfiles in each service; no `railway.json`). There is also a throwaway `smoke-test` Railway Function that runs a live capture of 3 Wikimedia photos; delete it when Milestone 1 is signed off.

**Keys:** live only in Railway Variables (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_*`, `DEV_AUTH_CODE`). Never paste keys into chat or commit them. The iOS app holds only the dev auth code (not a secret) until Sign in with Apple ships.

**Models:** `claude-sonnet-5-5` for the GM, identification and SKU research; `claude-haiku-4-5-20251001` for detection, consolidation, price research, photo scoring, Refiner questions and memory.

**Repo conventions:** branches `m<N>/<name>`, squash-merge PRs into `main` with green CI, commits authored `Sean Lo <s3an0506@gmail.com>` with the Co-Authored-By trailer. GitHub GraphQL was blocked in the old environment, so everything used `gh api` REST.

## What is built

**Milestone 0 (foundations):** monorepo, CI (backend, matcher, migrations, iOS with `pipefail`), all PRD tables with RLS, API with `/v1/me`, idempotency middleware, dev email sign-in (`/auth/dev-session`, `/auth/refresh`), iOS shell with design system and shaders. Sign in with Apple is not done (no Apple Developer account yet).

**Milestone 1 (Shelf and appraisal), functionally complete:**
- **Capture:** photos or video (1 fps sampling, Laplacian blur filter, at most 30 frames), signed-URL uploads with retry, progress with the scan shader, items appear as they're identified.
- **Appraiser:** Haiku detection with a coordinate grid, two-pass crop refinement (`box_in_crop`), a single Haiku consolidation call per capture to merge duplicates, Sonnet identification, Haiku price research with web search, a 7-day `price_cache`, Voyage embeddings, privacy exclusions (medication, hygiene, documents, fixtures).
- **Item readiness (PRD "Item readiness"):** logged, identified, showcase, computed by a database trigger. Photo score 0 to 100; Studio view unlocks at 50 and showcase at 75 plus category angles.
- **Refiner agent:** scores photos, writes cheapest-first questions (yes_no, choice from SKU research, picker, text, photo), folds answers back in, re-prices when a value driver changes.
- **iOS:** Shelf with readiness marks and filters, product card sheet, Tune up card stack, Showcase shoot camera (AVFoundation), Studio photo (Vision subject lift), item edit, follow-up photos.
- **Evals:** appraisal capture runner (`eval:appraisal`, `eval:label`), plus refinement and appraisal cases.

**Milestone 2 (GM and Asks), merged and deployed but never run live:**
- **GM harness:** streaming loop, tools from the PRD table, session ID allow-list, fenced untrusted text, prompt caching (global, session, volatile), intake skill, `agent_runs` and `agent_events`, memory job after each turn.
- **API:** `GET /v1/gm/conversation`, `POST /v1/gm/messages`, `GET /v1/gm/stream/{id}` (SSE), `/v1/asks` CRUD, `/v1/me/taste-facts`.
- **Workers:** `extract_memory` job with a write validator that blocks sensitive categories.
- **iOS:** live GM chat with native cards (item cards, choices, camera request, Ask card, recap), intake during onboarding, Ask detail (offer set, cash ceiling slider, autonomy), live taste facts. Demo mode (`-demo`) is scripted.
- **Evals:** 25 GM cases (grounding, intake, ask_resolution, safety) and 6 memory cases; `eval:gm` runner.

## Open bugs and gaps

| Issue | Impact | Fix |
| --- | --- | --- |
| `patch_ask` database function is not applied to `throwin-dev` | `PATCH /v1/asks/{id}` fails (iOS Ask detail edits). The GM can still create Asks. | Apply the `patch_ask` part of `supabase/migrations/20261008000300_asks_and_taste_facts.sql`. The Supabase connector cancels it because the body contains `delete`, so Sean must approve it or run it in the SQL editor. The rest of that migration is applied. |
| GM never run against the real model or database | Unknown failures in the Supabase data layer and prompts | Live test (next steps). |
| GM writes Asks directly instead of through the Asks module | 2 code paths for Ask rules; offer set update in the harness isn't atomic | Make harness tools call the Asks repo and `patch_ask`. |
| Migration history names on Supabase differ from the local file names | `supabase db push` will misbehave | Run `supabase migration repair` before the first push. |
| Skipped data backfills | Old items keep status `needs_photos` and stale readiness (the app treats them fine) | Optional: `update items set status='on_shelf' where status='needs_photos'; update items set readiness=readiness;` after Sean approves. |
| Pricing cost about 8 cents per item all in | Above the PRD budget (target 3 cents for pricing) | Try `PRICE_MAX_SEARCHES=1`, measure via `agent_runs`. |
| Showcase shoot thresholds and Studio look | Untested on a real camera | Test on Sean's iPhone. |
| Tune up stacking fix, readiness spread rule, worker concurrency (PR #19) | Merged, not seen in the Simulator yet | Quick visual check. |
| No labeled eval set | The Milestone 1 gate (10 items, 8 correct, under 60 s) is unmeasured | Sean films real shelves; label with `eval:label`. |
| Sign in with Apple, push notifications, App Attest | Not built | Needs the Apple Developer account ($99). |

## Immediate next steps

1. **Unblock Ask edits:** get Sean's OK and apply `patch_ask`.
2. **Live-test Milestone 2:** run an intake and an Ask through the live API (Simulator, or a Railway Function like `smoke-test`), then fix what breaks. Check `agent_runs` cost and cache hit rate for the GM.
3. **Reconcile the GM with the Asks module** (single Ask write path, atomic offer sets).
4. **Run the evals with a real key:** `eval:gm`, `eval:appraisal` on Sean's media in the gitignored `evals/media/` (his nightstand photo and 2 videos are on his Mac at `~/Claude/throwin-debug-media/`).
5. **Milestone 3:** matcher service deploy, Prospector, Liaison, Deal staging and Deal Sheets (PRD "Build plan").

## Testing tips

- **Simulator test media:** DEBUG Simulator builds show a "Test media" menu in the capture sheet that loads sets from `~/Claude/throwin-debug-media/<set>/` on the Mac.
- **Smoke test:** redeploy the `smoke-test` Railway Function to run a live capture and read its logs.
- **Local checks:** `pnpm -r typecheck && pnpm -r lint && pnpm -r test`, `./scripts/check-migrations.sh`, `cd services/matcher && pytest`.
