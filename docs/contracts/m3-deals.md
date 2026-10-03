# Milestone 3 contract: Deal staging and lifecycle

How a matcher Deal becomes rows in `deals`, `deal_legs` and `deal_participants`, and how it moves until approval. Product intent lives in `docs/prd.md` ("From candidate to Deal Sheet", "Item readiness" rules, "Domain objects and the Ask lifecycle"). The Deal Sheet API and approvals come in a later contract.

## Lifecycle

| Status | Means | Items | Asks | Ends |
| --- | --- | --- | --- | --- |
| `staged` | Matched and held, waiting for every Item to reach `showcase` | reserved | `proposed` | 24 hours after staging |
| `pending_approvals` | Every Item is `showcase`; participants decide | reserved | `proposed` | 48 hours after it got here |
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

## Not yet

- Just-in-time photo requests to owners of non-showcase Items: needs notifications.
- Approve, decline and counter, plus the Deal Sheet reads: next.
- Claude's taste-fact review and the "why": it will sit between matching and staging.
