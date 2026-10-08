# Home

Oct 7, 2026, redesigned after the first 2-phone dogfood. Sean rated the old Home 40 of 100: a stack of same-looking chores, truncated titles, a black pill on every row, no sense of what's moving, and nothing changed until you pulled to refresh. Design tokens and motion come from `docs/design.md`.

## What Home is for

Opening the app, a person wants to know 3 things, in this order:

1. **Does anything need me?** A Deal to approve, someone who wants my Item, a counter, a quick question. Few, time-bound, and the reason the app exists.
2. **What's my GM doing for me?** Every trade in flight and where it stands.
3. **Is there anything I could do to get more trades?** Optional: a better offer, a quick Tune up, something people in my Circles want.

Home answers those in about 2 seconds and then ends. It's a briefing from your GM, not a feed.

## Decisions

| Question | Answer | Why |
| --- | --- | --- |
| Is Home a feed? | No. Home is finite and ends with "All caught up". Browsing other people's Shelves belongs in Circles. | Feeds are endless and make you feel behind. The GM's job is to do the browsing for you. |
| Do notifications just stack? | No. Decisions go in a deck: 1 card at full size, the next one peeking, a count. Chores collapse into 1 card of at most 3 suggestions. Home's height stays the same at 2 items or 20. | A tall stack of same-weight cards was the 40-of-100 problem: nothing stood out. |
| Do our trades live on Home? | Yes. "Your trades" is 1 card with a row per Ask: what you asked for, a 4-step track (Looking, Found, Agreed, Done) and 1 live line in the GM's words. | It's what you'd otherwise open 3 screens to piece together. A track reads at a glance, like a delivery tracker. |
| Do we need a notification center? | No separate one. Everything that needs you is already in the deck. A history of what your GM did (the PRD's Activity log, backed by `agent_events`) comes with Milestone 5, behind a button in the header. | 2 inboxes means 2 places to check. |
| How does the GM feel present? | Its orb and 1 sentence sit under the greeting: "2 things need you. I'm still looking for your Jordans." The orb swirls while it's working. Tap it to talk. | Being proactive means saying what it did and what it's doing, in 1 line, without a chat bubble. |
| How fresh is it? | Home refreshes itself every 15 seconds while you're looking at it, and when the app comes back to the front. Changes spring in; nobody pulls to refresh. | Things happen while you watch: a Deal lands, someone answers. |

## Layout

1. **Briefing.** Weekday and date, "Evening, Jackson", your avatar. Under it, the GM line with its orb.
2. **Needs you** (only when something does). A horizontal deck of decision cards, 1 per thing, soonest to expire first. Each card is built for its decision:
   - **Deal ready:** what you give (warm tiles) and get (cool tiles), whose it is, the cash line, hours left, Review. The Loop-gradient rim marks the 1 loud moment.
   - **Counter:** the same card, gold, with the change in 1 line.
   - **Someone wants your Item:** your Item, who's looking, and thumbnails of what they'd trade. See trade.
   - **Quick question** (the Liaison): the Item, the question, and No / Yes right on the card. 1 tap, no sheet.
   - **1 step to a Deal:** a Deal waits on your Item: 2 quick answers or 1 photo. The button goes straight there.
3. **Your trades.** 1 card, a row per open Ask, then New Ask.
4. **From your GM** (only when there's something). At most 3 compact rows: a long-shot offer to fix, an Ask with nothing offered, something people in your Circles want, Tune up questions, photos that would make an Item ready to show.

New people see a 3-step "Get started" card in place of the deck: add things, tell your GM 1 want, join a Circle.

## Rules

- Titles are short and never cut off mid-word: "Your Insta360 X3", not "Insta360 X3 360 Action Camera". Use brand and model when we have them.
- 1 primary button per card, named for what it does. Rows use a chevron, not a button.
- Color is spent on meaning: warm for give, cool for get, gold for cash and counters, iris for the GM, mint for done. Everything else is paper.
- Every change animates with the design springs. Counts roll, lines cross-fade, cards slide in.
- Loading never shows an empty screen: the last known state stays until new data arrives. First launch shows the layout with placeholders.
