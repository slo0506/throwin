# Milestone 3 contract: the matcher

The shapes the Prospector (TypeScript worker) and the matcher (Python service, `services/matcher`) share. Product intent lives in `docs/prd.md` ("Matching, prospecting and multi-party deals"). If code and this file disagree, fix the code or change this file in the same PR.

The matcher is deterministic and stateless: no LLM, no database. The Prospector builds the want graph from the database, calls the matcher, reviews the result against taste facts, and stages Deals.

All JSON is snake_case. Money is integer cents. IDs are strings (UUIDs in practice).

## POST /v1/match

### Request

```json
{
  "edges": [
    {
      "from_user": "uuid (wants the Item)",
      "to_user": "uuid (would give it)",
      "item_id": "uuid",
      "value_cents": 21500,
      "ask_id": "uuid or null",
      "cash_ceiling_cents": 2000,
      "utility": 1.4,
      "confidence": 0.9,
      "kind": "explicit | inferred"
    }
  ],
  "anchor_user": "uuid or null",
  "max_length": 4,
  "max_cycles": 10000,
  "tolerance_pct": 0.15,
  "tolerance_floor_cents": 1000,
  "time_limit_seconds": 5,
  "weights": { "utility": 1, "cash_per_dollar": 0.02, "extra_person": 0.25, "low_confidence": 1, "inferred_edge": 0.3 }
}
```

- **Edges:** 1 per (wanter, Item) pair. `value_cents` is the Item's `value_mid_cents`. `cash_ceiling_cents` is the wanter's ceiling on `ask_id` (0 when the edge is not tied to an Ask). Only Items that are `on_shelf`, unreserved and in the giver's offer set belong in the graph.
- **Live mode:** set `anchor_user` to the asker; only cycles that include them come back. **Drop mode:** leave it null to search the whole Circle.
- Everything but `edges` has the defaults shown.

### Response

```json
{
  "deals": [
    {
      "users": ["a", "b"],
      "item_legs": [
        { "giver": "b", "receiver": "a", "item_id": "bat", "value_cents": 20000, "ask_id": "ask-a", "kind": "explicit" },
        { "giver": "a", "receiver": "b", "item_id": "set", "value_cents": 15000, "ask_id": null, "kind": "explicit" }
      ],
      "cash_legs": [{ "payer": "a", "payee": "b", "amount_cents": 2000 }],
      "fairness": [
        { "user": "a", "gives_cents": 15000, "gets_cents": 20000, "cash_in_cents": 0, "cash_out_cents": 2000, "net_cents": 3000, "tolerance_cents": 3000 },
        { "user": "b", "gives_cents": 20000, "gets_cents": 15000, "cash_in_cents": 2000, "cash_out_cents": 0, "net_cents": -3000, "tolerance_cents": 3000 }
      ],
      "cash_moved_cents": 2000,
      "score": 1.6
    }
  ],
  "cycles_found": 1,
  "cycles_balanced": 1,
  "truncated": false,
  "optimal": true
}
```

- `deals` are best score first. Each maps to `deals` plus `deal_legs` rows: 1 leg per `item_legs` entry, and 1 cash-only leg (`item_id` null, `throw_in_cents`) per `cash_legs` entry. `fairness` goes in `deals.fairness`.
- `truncated` means the search stopped at `max_cycles`. `optimal` is false when selection hit its time limit; the deals are still valid, just possibly not the best set.

## Rules the matcher guarantees

These are property-tested in `services/matcher/tests/test_properties.py` on 200 random Circles per run.

1. **Close to even:** each person's `net_cents` (value received minus value given, plus cash in minus cash out) is within `tolerance_cents` = max(`tolerance_pct` of the larger of the 2 Items they touch, `tolerance_floor_cents`).
2. **Ceilings hold:** nobody pays more than `cash_ceiling_cents` on the edge they receive through.
3. **Least cash:** among Throw-Ins that satisfy 1 and 2, total cash moved is the smallest; ties go to the split closest to even.
4. **No double promises:** an Item appears in at most 1 returned Deal, and an Ask (`from_user`, `ask_id`) is filled at most once. Live mode therefore returns at most 1 Deal.
5. **Only positive scores:** a cycle whose score is 0 or less is never proposed.
6. **Real wants only:** every item leg is an input edge, and every participant gives exactly 1 Item and gets exactly 1.

## Score

`utility × sum(edge utility) − cash_per_dollar × dollars moved − extra_person × (people − 2) − low_confidence × (1 − lowest edge confidence) − inferred_edge × inferred edges`

The weights are starting points. The Prospector passes its own once evals give us a basis for tuning them.

## Not the matcher's job

Taste-fact review, the "why" for each participant, Liaison inquiries for inferred edges, the showcase check, reservation and expiry all happen in the Prospector and the API.
