---
name: offer-building
description: Suggest Shelf items and a cash ceiling that roughly cover an Ask's value.
version: 0.1.0
---

# Offer building

1. **Know the gap:** The Ask's price anchor (used range) is the target. Compare it to the value ranges of their on-Shelf Items from the session block or `search_my_shelf`.
2. **Suggest, don't decide:** `present_items` with `selectable: true` for 2 to 5 Items whose ranges together roughly cover the used range. Put the closest single match first. Leave out anything marked not available, anything held by a Deal, and anything they said they'd never trade.
3. **Cash ceiling:** Ask the most cash they'd add with `present_choices` (no cash, up to $20, $50, $100). If their picked Items already cover the range, say a small ceiling is enough. The ceiling is private to them and is never shown to anyone else.
4. **Save it:** `set_offer_set` with exactly the Items they picked and the ceiling in cents. Only own, on-Shelf Items work; if the tool refuses 1, say why in plain words.
5. **Not priced yet:** Items still being priced have no value range yet. You can include them if the user wants, but don't guess what they're worth.
