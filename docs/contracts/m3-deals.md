# Milestone 3 contract: Deal staging and lifecycle

How a matcher Deal becomes rows in `deals`, `deal_legs` and `deal_participants`, how it moves until approval, and the Deal Sheet API. Product intent lives in `docs/prd.md` ("The Deal Sheet", "From candidate to Deal Sheet", "Item readiness" rules, "Domain objects and the Ask lifecycle").

## Lifecycle

| Status | Means | Items | Asks | Ends |
| --- | --- | --- | --- | --- |
| `staged` | Matched and held, waiting for every Item to reach `showcase` | reserved | `proposed` | 24 hours after staging |
| `pending_approvals` | Every Item is `showcase`; participants decide | reserved | `proposed` | 48 hours after it got here |
| `approved` | Everyone approved | still reserved, for the handoff | `accepted` | Handoffs (Milestone 4) |
| `cancelled` | Expired or declined | released to `on_shelf` | back to `prospecting` | |

- A Deal whose Items are all `showcase` when it's staged skips `staged`.
- Promotion is automatic: when an Item in a staged Deal becomes `showcase` and it was the last one, the Deal moves to `pending_approvals` and the 48-hour clock starts.
- Sending Asks back to `prospecting` queues a `prospect_ask` for each of them, which is the PRD's "re-match for everyone else".
- Nobody sees a Deal Sheet for a `staged` Deal. Deal Sheet reads return only `pending_approvals` and later statuses.

## Database functions (service role only)

| Function | Does |
| --- | --- |
| `stage_deal(deal jsonb, mode, run_id)` | Stages 1 `deals` entry from `/v1/match`, in 1 transaction. Returns `{ result, deal_id? }`. |
| `close_deal(deal_id, status)` | Sets the status, releases Items, sends the Deal's `proposed` Asks back to `prospecting`. False if the Deal wasn't open. |
| `expire_deals()` | Closes every open Deal past `expires_at` as `cancelled`. Returns the count. The worker calls it every minute. |

`stage_deal` re-checks everything the matcher assumed, because the database may have moved on since:

| Result | When |
| --- | --- |
| `ok` | Staged. Items reserved, 1 `deal_legs` row per Item (with the `ask_id` it fills) and per Throw-In (`item_id` null), 1 pending participant per person, Asks `proposed`. |
| `invalid` | Fewer than 2 legs, someone who doesn't give and get exactly 1 Item, a repeated Item, or cash to or from a non-participant |
| `ask_unavailable` | An Ask isn't its receiver's or isn't `prospecting` |
| `offer_changed` | An Item isn't its giver's, or left the offer set it was matched from |
| `over_ceiling` | Someone would pay more than the cash ceiling of the Ask the Deal fills for them |
| `items_taken` | An Item is reserved, traded or off the Shelf. Nothing is written. |

`deals.fairness` stores `{ "participants": [matcher fairness], "cash_moved_cents", "score" }`.

## The review before staging

Between matching and staging, the Prospector reviews each Deal (`services/workers/src/prospector/review.ts`, prompt in `prompts.ts`, Sonnet). It sees each participant's side (titles fenced as untrusted, condition, value ranges, cash) and their active `limits`, `hunting`, `interests` and `style` facts, then keeps or drops the Deal and writes 1 why per person. Code enforces the hard rules:

- **Never-trade:** a participant giving an Item whose title contains one of their own `limits` facts drops the Deal before any model call.
- **Grounded amounts:** a why may only quote dollar amounts from its reader's own side (their Items' ranges and their cash). Otherwise it's discarded.
- **Privacy:** a why that repeats another participant's `limits` fact is discarded.
- **Style:** em dashes and exclamation marks are cleaned, and whys are capped at 220 characters.

A dropped Deal is never staged; the job log records the reason. Kept Deals pass their whys to `stage_deal` as `p_deal.whys` (`{ "<user id>": "<why>" }`), stored in `deal_participants.why`. Eval cases live in `evals/cases/deal_explanation`, and `eval:review` runs them against the real model.

## Deal Sheet API

All JSON is snake_case and money is integer cents. Someone else's Deal, or a `staged` one, is a 404.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/v1/deals` | | `{ "deals": [DealSheet] }`: the caller's Deals awaiting approval or later but not finished, newest first |
| GET | `/v1/deals/{id}` | | DealSheet, including cancelled ones |
| POST | `/v1/deals/{id}/approve` | | DealSheet after the approval |
| POST | `/v1/deals/{id}/decline` | `{ "reason"?: up to 200 chars }` | DealSheet, now `cancelled` |

```json
{
  "id": "uuid",
  "status": "pending_approvals",
  "expires_at": "...",
  "you_give": DealItem, "give_to": DealPerson,
  "you_get": DealItem, "get_from": DealPerson,
  "cash": { "pay_cents": 2000, "receive_cents": 0 },
  "fairness": { "give_cents": 4200, "get_cents": 8500 },
  "loop": [{ "giver": DealPerson, "receiver": DealPerson, "item": DealItem }],
  "throw_ins": [{ "payer": DealPerson, "payee": DealPerson, "amount_cents": 2000 }],
  "participants": [{ "...DealPerson", "approval": "pending | approved | declined" }],
  "your_approval": "pending",
  "why": null,
  "your_ask_id": "uuid or null"
}
```

- `DealItem` is `{ id, title, category, brand, model, condition_grade, value: ValueRange, photo_url }`. Every Item is showcase by the time a Deal is shown, so photos are always included.
- `DealPerson` is `{ user_id, first_name, photo_url }`.
- `fairness` holds the mid values of what the caller gives and gets, for "You give about $42 in value and get about $85". Everyone sees the same Items and ranges in `loop`, and nobody's cash ceiling ever appears.
- `why` is the caller's own "why your GM likes it", written by the Prospector's review. Each person sees only their own, and it's null when the review wrote none.
- `your_ask_id` is the caller's own Ask this Deal fills (the leg they receive through), so the app can link an Ask to its waiting Deal. Never anyone else's Ask.

### Decisions

`approve_deal(user, deal, snapshot)` and `decline_deal(user, deal, reason)` run in 1 transaction each and return:

| Result | HTTP | When |
| --- | --- | --- |
| `ok` | 200 | Recorded |
| `not_found` | 404 | Not the caller's Deal, or still staged |
| `closed` | 409 `deal_closed` | Not awaiting approvals, or expired |
| `decided` | 409 `already_decided` | The caller already approved or declined |

- **Approve** stores the caller's Deal Sheet as it was at that moment in `deal_participants.sheet_snapshot`. When the last person approves, the Deal becomes `approved` and its Asks `accepted`. Items stay reserved for the handoff, and approved Deals never expire.
- **Decline** cancels the Deal for everyone, through `close_deal`, and records `(the decliner's Ask, the Item they'd have received)` in `ask_exclusions`. `circle_want_candidates` skips those pairs, so the re-match never offers the same Item for that Ask again.
- **Device-bound confirmation:** the PRD requires Face ID or a passkey on approve. The server can't verify either until App Attest or passkeys ship (both need the Apple Developer account), so until then the app checks Face ID locally before calling approve.

## Not yet

- Counter (a different Throw-In or Item) re-running the match.
- Just-in-time photo requests to owners of non-showcase Items: needs notifications.
