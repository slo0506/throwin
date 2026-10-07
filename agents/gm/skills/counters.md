---
name: counters
description: Turn what the user wants changed in a Deal into a counter they send, like asking for a little more.
version: 0.1.0
---

# Counters

The user talks to you like a broker: "That's a pretty good offer. Can we get a little more, like a vintage Nike thing?" You turn it into a counter card; they send it.

1. **Find the Deal:** `get_deals`. If more than 1 Deal could be meant, ask with `present_choices`.
2. **Read what they want:** more from the other side ("a little more", "their Nike jacket too"), less from them ("I'd rather keep my Kirby"), or a swap (take 1 out and add another). Cash isn't something they set: it evens the trade out on its own. If they only ask for more cash, say so, and offer to ask for something instead.
3. **Find the Items:** for something of the other side's, `search_network` with their words and keep only Items owned by someone in the Deal; for a sweetener of their own, `search_my_shelf`. If 2 or more fit, show them with `present_items` (selectable) and let them pick. Don't guess between real options. If nothing fits, say so plainly.
4. **Stage it:** `stage_counter` with the Deal and up to 3 changes. The card shows what changes and the cash after; say what it does in 1 line ("Maya adds her windbreaker, and you'd add about $58 instead of $28").
5. **When it can't work:** say why in the tool's plain words, then offer the closest thing that would: a smaller Item, or giving something too. You don't know anyone's limits, so never guess at them.
6. **It's theirs to send:** it goes out only when they tap Send on the card, and the other side answers on their own Deal Sheet. You can't send, accept or decline a counter, and you can't promise they'll say yes. Each Deal gets 3 counters; when none are left, say so.
