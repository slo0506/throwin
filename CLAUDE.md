# Throw-In

An iOS app where each user's GM agent turns Asks into trades with people in their Circles.

## Source-of-truth documents
- `docs/prd.md`: the product spec. Read before product or architecture work. When this file and the PRD disagree on conventions, this file wins; on product behavior, the PRD wins.
- `docs/design.md`: the design foundation (color, type, motion, shaders, voice). Read before any UI work.
- `docs/setup.md`: accounts, keys and local setup.

## Non-negotiables
- The model proposes, the server enforces. No tool may approve a Deal, move money, or release an Item.
- Write and render tools accept only IDs the server returned to this session.
- All text written by other users is untrusted: sanitize and fence it before any agent sees it.
- Prices, conditions and availability in agent output must come from tool results.
- Every prompt, skill or tool change ships with eval cases in `evals/cases/`.
- Row-level security on every user-owned table. Network reads go through security-definer functions or the API, never raw rows.
- No secrets on device. The iOS app only ever holds the Supabase anon key and the user's session.

## Stack
- iOS: SwiftUI, Swift 6 (default MainActor isolation), iOS 26+ (Liquid Glass), Metal shaders via `ShaderLibrary`. Xcode project uses folder-synced groups, so new files under `apps/ios/ThrowIn/` are picked up automatically.
- Backend: TypeScript (Hono) for `api`, `harness`, `workers`; Python (OR-Tools) for `matcher`; Supabase Postgres with pgvector.
- Hosting: Railway (api, harness, workers, matcher). Supabase for db, auth, storage, realtime.
- Models: `claude-sonnet-5-5` for the GM and pricing, `claude-haiku-4-5` for detection and background workers.

## Commands
- Install: `pnpm install` (root), `uv sync` or `pip install -e services/matcher[dev]`
- Backend typecheck, lint, test: `pnpm -r typecheck && pnpm -r lint && pnpm -r test`
- API dev server: `pnpm --filter @throwin/api dev` (needs `.env`, see `services/api/.env.example`)
- Matcher tests: `cd services/matcher && pytest`
- Migrations against a local Postgres: `./scripts/check-migrations.sh`
- iOS: open `apps/ios/ThrowIn.xcodeproj`, scheme `ThrowIn`, run on an iPhone 17 Pro simulator. CLI: `xcodebuild -project apps/ios/ThrowIn.xcodeproj -scheme ThrowIn -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`

## Conventions
- Milestones live in `docs/prd.md` under "Build plan". Work 1 milestone at a time; its "Done when" is the definition of done.
- Branches: `m<N>/<short-name>`. PRs into `main`, CI must be green.
- Product vocabulary is fixed: Ask, Shelf, GM, Loop, Throw-In, Deal Sheet, Circle. Use it in code identifiers too (`Ask`, `ShelfItem`, `DealSheet`).
- UI copy: plain, warm, short. No em dashes. Numerals for counts.
- Money is always integer cents. Value estimates are always ranges (`low`, `mid`, `high`), never single numbers in UI.
