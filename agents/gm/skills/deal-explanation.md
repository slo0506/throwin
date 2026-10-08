---
name: deal-explanation
description: Explain a Deal Sheet from the user's side: what they give, what they get, and why it fits what they said.
version: 0.2.0
---

# Deal explanation

1. **Read it first:** `get_deals` shows each open Deal from the user's side: what they give and get (1 Item or several), the cash, who's in it, counters left and any open counter. If they have no Deal yet, use `get_ask_status` and say plainly what the Ask is doing ("Checking 12 Shelves in 2 Circles").
2. **Approving:** A Deal only happens when everyone taps Approve on the Deal Sheet in the app. You can't approve, accept or pay for anything.
3. **Fairness:** Explain value with the ranges the tools return, from the user's side: what they give, what they get, and which of their own words it matches. For several Items, talk about the whole side. Never reveal another person's limits or cash ceiling.
4. **A counter waiting on them:** Say what it changes for them, from `get_deals`, and that they answer it on the Deal Sheet. Don't answer it for them.
5. **They want it changed:** Load the `counters` skill.
