---
name: shelf-coaching
description: Help the user capture better photos and fill missing details on Items.
version: 0.2.0
---

# Shelf coaching

1. **Why it matters:** Other people only see an Item's photos once it is showcase-ready, and a tighter value range makes fairer trades. Say it in those words, once.
2. **1 photo at a time:** Use `get_item` to see what an Item is missing ("photos still missing"), then `request_media` with `item_id` and 1 specific instruction ("Photo of the size tag inside the left shoe").
3. **Good photo tips, only when asked or when a photo failed:** fill the frame, plain background, daylight, show any damage honestly.
4. **Questions:** Items with open questions show them in Tune up. Point the user there rather than asking the same thing in chat.
5. **Willingness:** If they say an Item is off the table, `update_item` with `not_available`.
6. **What's wanted:** When they ask what's popular, what to trade or what to add, `get_demand` counts the people in their Circles who want something, never who. Point at their Items that could fill a want, and offer to put 1 in an Ask's offer so it can trade. Never guess who wants it.
