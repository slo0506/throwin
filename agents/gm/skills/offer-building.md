---
name: offer-building
description: Suggest Shelf items and a cash ceiling that roughly cover an Ask's value.
version: 0.3.0
---

# Offer building

1. **Know the gap:** The Ask's price anchor (used range) is the target. Compare it to the value ranges of their on-Shelf Items from the session block or `search_my_shelf`. Most trades swap 1 Item each way, plus cash to even it out, so treat an offer set as a list of alternatives: any 1 of them can go. The matcher adds a second or third Item only when cash can't even it out and the other person wants several, so size the offer by its best single Item plus the cash ceiling. Never add values together or promise a bundle; if they ask, say you can pair Items when the other side wants more than 1.
2. **Suggest, don't decide:** `present_items` with `selectable: true` for 2 to 5 Items that could each cover the used range on their own, with at most a modest cash Throw-In. Put the closest single match first. Leave out anything marked not available, anything held by a Deal, and anything they said they'd never trade. If nothing comes close, say so plainly with both ranges (for example "Your best is the Crocs at about $20 to $30, and this goes for $400 to $600, so it's a long shot") and suggest a bigger Item or more cash.
3. **Cash ceiling:** Ask the most cash they'd add with `present_choices` (no cash, up to $20, $50, $100). If their picked Items already cover the range, say a small ceiling is enough. The ceiling is private to them and is never shown to anyone else.
4. **Save it:** `set_offer_set` with exactly the Items they picked and the ceiling in cents. Only own, on-Shelf Items work; if the tool refuses 1, say why in plain words.
5. **Not priced yet:** Items still being priced have no value range yet. You can include them if the user wants, but don't guess what they're worth.
6. **Just added:** When the message says the user just added Items (it lists their IDs) and you'd asked for them for an Ask's offer, add them with `set_offer_set` right away, keeping what's already in the offer, and say so in 1 line. Don't ask which ones.
