# Milestone 2 contract: GM, Asks and taste facts

The single source of truth for the shapes that the harness, the API, the workers and the iOS app share in Milestone 2. Product intent lives in `docs/prd.md` ("Posting an Ask", "First-time experience", "GM tools", "Context and caching", "Memory", "GM conversation"). If code and this file disagree, fix the code or change this file in the same PR.

All JSON is snake_case. Money is integer cents. Values are ranges. IDs are UUIDs. Every POST and PATCH accepts `Idempotency-Key`.

## Architecture

- **Harness as a library:** `services/harness` is the package `@throwin/harness`: the agent loop on the Messages API, the tool registry, the session ID allow-list, the untrusted-text sanitizer and fences, and prompt caching. `services/api` mounts the GM routes and runs the harness in process, so there is 1 deploy, 1 auth path and 1 domain. Streams are held in memory per API instance, which is fine while there is 1 instance.
- **GM prompt and skills:** `agents/gm/system.md` and `agents/gm/skills/*.md`, loaded at boot, versioned with `GM_PROMPT_VERSION`.
- **Models:** `claude-sonnet-5-5` for the GM, `claude-haiku-4-5-20251001` for the memory extractor.

## Ask

```json
{
  "id": "uuid",
  "raw_text": "the big Lego Batmobile",
  "title": "LEGO Batman Batmobile Tumbler 76240",
  "status": "drafting | offering | prospecting | proposed | accepted | fulfilled | expired | cancelled",
  "status_line": "Checking 46 Shelves in 2 Circles",
  "target": {
    "kind": "exact | category",
    "name": "LEGO Batman Batmobile Tumbler",
    "brand": "LEGO",
    "model": "76240",
    "category": "toys/lego",
    "constraints": ["built is fine", "no missing pieces"],
    "anchor": { "retail_cents": 26999, "used_low_cents": 18000, "used_high_cents": 25000 },
    "image_url": "https://... or null (a reference product photo from a page the research cited)"
  },
  "offer_item_ids": ["uuid"],
  "offer_value": { "low_cents": 14000, "high_cents": 21000 },
  "cash_ceiling_cents": 2000,
  "max_items": 1,
  "autonomy": "every_deal | likely_yes",
  "deadline": "2026-10-20T00:00:00Z or null",
  "created_at": "...",
  "updated_at": "..."
}
```

- `cash_ceiling_cents` is returned only to the Ask's owner and never leaves through network functions.
- `max_items` (1 to 5, default 1) is how many Items the Ask takes, so 1 trade can bring several ("2 or 3 board games"; bundles, `docs/contracts/m3-matcher.md`). The GM sets it with `upsert_ask` when the user clearly wants several, and the Ask page has a stepper. Changing it on a prospecting Ask re-matches it.
- `status_line` is plain words computed by the server ("Waiting for what you'd offer", "Checking 46 Shelves in 2 Circles").
- `title` is a new column on `asks` (nullable, set from the resolved target).
- `target` is null and `status` is `drafting` until the target resolves; creating or patching with a `target` moves a drafting Ask to `offering`. Target fields other than `kind` and `name` default to null (`constraints` to `[]`).
- `offer_value` is `{ "low_cents": 0, "high_cents": 0 }` when nothing is offered. Unpriced Items add nothing; removed and traded Items drop out of `offer_item_ids`.
- Errors: someone else's or a missing Ask is 404 `not_found`; a bad offer Item is 400 `invalid_offer_item`; any edit to a fulfilled, expired or cancelled Ask is 409 `ask_closed` (cancelling a cancelled Ask is a no-op 200).

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/v1/asks` | | `{ "asks": [Ask] }`, newest first, excluding cancelled |
| POST | `/v1/asks` | `{ "raw_text": string, "target"?: Target, "cash_ceiling_cents"?: int, "max_items"?: int, "autonomy"?: string }` | 201 Ask |
| GET | `/v1/asks/{id}` | | Ask |
| PATCH | `/v1/asks/{id}` | any of `raw_text`, `target`, `offer_item_ids`, `cash_ceiling_cents` (0 to 100000), `max_items` (1 to 5), `autonomy`, `deadline`, `status: "cancelled"` | Ask |

Setting a non-empty offer set on a `drafting` or `offering` Ask moves it to `prospecting`. Offer items must be the owner's own, on the Shelf, not reserved.

## Taste facts

```json
{ "id": "uuid", "key": "never_trade", "value": "Millennium Falcon", "category": "limits", "source": "Intake chat", "always_on": true, "created_at": "..." }
```

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/v1/me/taste-facts` | `{ "facts": [TasteFact] }`, active only |
| DELETE | `/v1/me/taste-facts/{id}` | 204. Marks it `deleted`; the GM never uses it again. |

Categories: `interests`, `hunting`, `limits` (never trade), `preferences` (handoff spot, autonomy), `style`. The write validator rejects anything about health, religion, politics, sexuality, ethnicity, finances beyond trade budgets, and anything about another person.

`source` is 1 of "Intake chat", "Chat" or "Shelf edits". The `extract_memory` job payload is `{ "user_id", "conversation_id", "message_ids": [uuid], "mode"?: "intake" | "chat" }`; without `mode` the worker reads `conversations.mode` if that column exists, else assumes chat.

## GM conversation

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/v1/gm/conversation?id=` | | `{ "conversation_id", "mode": "intake" or "chat", "messages": [Message], "title", "is_main" }` for that conversation (404 `conversation_not_found` unless it's the user's), or without `id` the 1 used last. The very first is created on first call, with the intake greeting |
| GET | `/v1/gm/conversations` | | `{ "conversations": [{ "id", "title", "is_main", "updated_at" }] }`, most recently used first, at most 50 |
| POST | `/v1/gm/conversations` | | 201, a new empty conversation in the same shape as `GET /v1/gm/conversation` |
| POST | `/v1/gm/messages` | `{ "text"?: string, "choice"?: { "component_id": string, "option_ids": [string] }, "media_paths"?: [string], "added_item_ids"?: [uuid], "screen"?: string, "conversation_id"?: uuid }` (at least 1 of text, choice, media, added Items) | 202 `{ "stream_id", "message_id" }` |
| GET | `/v1/gm/stream/{stream_id}` | | `text/event-stream` |

`mode` is `intake` until the intake finishes (the GM records it with a tool), then `chat`. The intake happens once per person: a new conversation opens in `chat` mode once it's done.

**Conversations.** The main conversation (`is_main`) is the user's first, where the intake happened; the app pins it as "Your GM". Others are titled from the user's first words in them (about 48 characters, cut at a word). Memory (taste facts, the Shelf, Asks) is the user's, so the GM knows them the same in every conversation; each keeps its own history. 1 turn runs at a time per user, across conversations.

`added_item_ids` lists Items that just landed on the user's Shelf (for example from the GM's camera request), so the GM knows exactly which are new. Each must be the user's own (400 `invalid_item` otherwise).

### Message (history)

```json
{ "id": "uuid", "role": "user | assistant", "text": "...", "components": [Component], "created_at": "..." }
```

Components in history are rebuilt from the stored tool calls, so old cards render the same.

### Stream events

Each event is `event: <name>` plus `data: <json>`. Events, in the order they can occur:

| Event | Data | Meaning |
| --- | --- | --- |
| `text` | `{ "delta": string }` | Assistant text to append. |
| `progress` | `{ "label": string }` | A plain-words tool progress line ("Checking your Shelf"). Replaces the previous line. |
| `component` | `Component` | A UI card to render inline after the text so far. |
| `done` | `{ "message_id": string }` | The turn is complete. |
| `error` | `{ "code": string, "message": string }` | The turn failed; `message` is safe to show. |

A keep-alive comment line is sent every 15 seconds. The stream ends after `done` or `error`.

### Component

```json
{ "id": "uuid", "kind": "item_cards | choices | camera_request | ask_card | recap", "data": { } }
```

| kind | data |
| --- | --- |
| `item_cards` | `{ "items": [ShelfItem], "selectable": bool, "selected_ids": [string] }`. Own Items use the full ShelfItem; network Items use `{ id, title, category, condition_grade, value, thumbnail_url, owner_first_name, readiness }` and only appear when `showcase`. |
| `choices` | `{ "prompt": string, "options": [{ "id": string, "label": string, "detail"?: string }], "multiple": bool }` |
| `camera_request` | `{ "instruction": string, "item_id"?: string }` |
| `ask_card` | `Ask` |
| `recap` | `{ "paragraph": string, "sample_decisions": [{ "give": string, "get": string, "verdict": "yes" or "no", "why": string }] }` |

The user answers `choices` by posting `choice`. Selecting Items in a selectable `item_cards` also posts `choice` with the Item IDs as `option_ids`, and the recap's 2 chips post `choice` with `looks_right` or `fix_something`. The GM shows at most 1 `choices` card per turn.

## Harness rules (from the PRD non-negotiables)

- Write and render tools accept only IDs the server returned to this session (the allow-list).
- Text written by other users is sanitized and fenced before the model sees it.
- Prices, conditions and availability in GM output come from tool results.
- There is no tool that approves a Deal, moves money or releases an Item.
- Every model call writes an `agent_runs` row; every tool call writes an `agent_events` row (user-visible ones get a plain `summary` for the Activity log).
- After each finished turn the harness enqueues an `extract_memory` job with the conversation and message IDs.
