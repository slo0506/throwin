# @throwin/harness

The GM agent loop, run in process by `services/api` (contract: `docs/contracts/m2-gm-and-asks.md`).

## How a turn flows

1. **Prepare (`GmService.prepareTurn`):** Loads the user's conversation (created with the intake greeting on first use), rebuilds the session from stored rows (allow-list, resolved targets, rendered cards, shown dollar amounts), validates any `choice` against a card in this conversation and any `media_paths` against the user's own uploads, and stores the user message.
2. **Build the request (`context.ts`):** Global block (tool definitions and `agents/gm/system.md`, breakpoint at the end of the system prompt), then the session block (first name, mode, always-on taste facts, Shelf, open Asks, the intake guide while in intake) and the history, then this turn's words with a rolling breakpoint, then the volatile block (time and screen) after it.
3. **Loop (`loop.ts`):** Streams `claude-sonnet-5-5` with text deltas as `text` events. Each tool call emits a `progress` line, runs through the registry and, for render tools, emits a `component`. Results go back to the model until it ends the turn (at most 8 tool steps, then 1 wrap-up call without tools).
4. **Persist:** Assistant and tool-result rows go into `messages` as API-native content blocks, with the server's record of each tool call in `tool_calls` (issued IDs, card IDs and data, resolved targets). History and cards are rebuilt from those records.
5. **After:** Every model call writes `agent_runs` (agent `gm`), every tool call writes `agent_events` (write tools get a plain `summary` for the Activity log, allow-list rejections get their own event), and a finished turn enqueues an `extract_memory` job.

## Rules the code enforces

- **Allow-list:** Write and render tools accept only IDs this conversation was shown (tool results, the session block, the user's uploads). Anything else is a tool error the model reads.
- **Server-filled cards:** Cards carry IDs; the server fills prices, photos and grades. `upsert_ask` takes a `target_id` from `resolve_target`, so the price anchor can't be invented. `present_recap` refuses dollar amounts no tool showed.
- **Untrusted text:** Other members' titles, names and descriptions, plus web research, are sanitized and fenced with `fenceUntrusted` before the model sees them.
- **No dangerous tools:** There is no tool that approves a Deal, moves money, releases an Item or writes taste facts (`FORBIDDEN_TOOL_NAMES`).

## Data

`GmData` is everything the GM reads and writes. `SupabaseGmData` uses the service role and scopes every query by user ID; `MemoryGmData` backs tests and offline evals. `FakeModelClient` scripts the Messages API for tests.
