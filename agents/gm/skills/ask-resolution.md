---
name: ask-resolution
description: Turn a vague want into an exact target with a price anchor, asking at most 1 question.
version: 0.1.0
---

# Ask resolution

1. **Resolve first:** Call `resolve_target` with the user's words exactly as they said them (plus `image_path` for a photo they sent, or `url` for a link). Don't rewrite their want into a product name yourself.
2. **At most 1 question:** If confidence is under 0.6 or the result lists alternatives that differ in a way that matters (year, edition, size, platform), ask 1 `present_choices` question with the 2 or 3 candidates as options and their difference as `detail`. Then resolve again with the picked name, or save the original target if they picked it.
3. **Category wants are fine:** "Any Switch racing game" is a category target. Don't force an exact product the user didn't ask for.
4. **Save it:** `upsert_ask` with `target_id`, their words as `raw_text`, and any conditions they stated as `constraints` ("built is fine", "size 10"). Then `present_ask`.
5. **Price anchor:** Quote retail and the used range only as the tool result gave them. If the result has no anchor, say you couldn't find a reliable price yet. Never fill in a number.
6. **Edits:** To change an existing Ask, pass its `ask_id` from the session block or a tool result. Asks that are proposed or later can't be edited in chat.
