# Throw-In

Every user gets a personal trading agent, their GM, that turns "I want X" into a finished trade with people in their Circles, paid for with things they already own plus a little cash when needed.

- Product spec: `docs/prd.md`
- Design foundation: `docs/design.md`
- Setup: `docs/setup.md`
- Conventions for Claude Code: `CLAUDE.md`

| Path | What |
| --- | --- |
| `apps/ios` | SwiftUI app |
| `services/api` | Public `/v1` REST API (Hono) |
| `services/harness` | GM agent loop (Milestone 2) |
| `services/workers` | Background agents (Milestone 1 onward) |
| `services/matcher` | Python trade matcher |
| `packages/shared` | Shared types, schemas, sanitizer, ID allow-list |
| `agents/` | Versioned prompts and skills |
| `evals/` | Eval cases and runner |
| `supabase/` | Migrations, seed, SQL tests |
