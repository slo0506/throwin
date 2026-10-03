# Product Spec: AI-First Trading App

Oct 2, 2026 · @Sean Lo

## Summary

We are building **Throw-In** (working name), an invite-only iOS app where every user gets a personal trading agent that turns "I want X" into a finished trade, paid for with things they already own plus a little cash when needed.

**The core noun is the Ask.** You post an Ask ("I want the Lego Batman set"), your agent asks what you have to offer, then it prospects your network, assembles a 2, 3 or 4-person trade, and brings you a Deal Sheet to approve. The word works twice: it is a request, and in markets it is the price you are asking.

**The vocabulary borrows from NBA front offices on purpose:**

| Term | Meaning in the app |
| --- | --- |
| Ask | A want you post: an item, a category, or a vague description. |
| Shelf | Your inventory of things you are willing to trade, built from photos and video. |
| GM | Your personal agent. It knows your Shelf, your taste and your limits, and it works in the background. |
| Loop | A multi-party trade, for example A gives to B, B gives to C, C gives to A. |
| Throw-In | The cash or small item that balances an uneven trade. |
| Deal Sheet | The proposal card every participant approves before anything happens. |

**Name options (all need a trademark and App Store search before we commit):**

| Name | Why it fits | Risk |
| --- | --- | --- |
| Throw-In (recommended) | Names the move that makes multi-party trades work, and it sounds like trade talk. | A quick search found no consumer app with this name, but it is a common phrase. |
| GM | "Your GM" is how users will talk about the agent. | Too generic to own as a brand. |
| Loopwise | Points at the multi-party Loop, the thing marketplaces cannot do. | Less playful, and Tradeloops already uses "loops" for barter chains. |

**v1 scope:** an iOS app with real auth, invite-only Circles (friend groups, offices, hobby clubs), Shelf capture from photos and video, Asks, background prospecting, multi-party Loops with optional cash Throw-Ins, in-person handoffs, and ratings. Shipping, authentication of goods, and selling to outside marketplaces are out of scope for v1.

## Strategy

The bet is that agents make trading between ordinary people practical again, because the expensive part of a trade was always finding the right counterparty and agreeing on terms, not the trade itself.

### Thesis

- **Supply is the bottleneck:** ThredUp's 2026 Resale Report found that the supply of secondhand goods, not demand, is resale's primary constraint ([WWD](https://wwd.com/sustainability/business/thredup-2026-resale-report-secondhand-growth-1238871192/)).
- **Barter failed on search cost, and agents remove it:** Anthropic's Project Swap argues that agents could enable new decentralized markets by cutting the effort of finding counterparties and negotiating, since an agent's attention is far less scarce than a person's ([Project Swap](https://www.anthropic.com/research/project-swap)).
- **Trades are positive-sum:** Haggling over price splits value between 2 people. A trade creates value, because each person ends up with something they value more than what they gave up.
- **Understanding is the product:** In Project Swap, most of the gap from the best possible outcome came from agents misunderstanding what people wanted, not from how agents traded. So we invest first in how the GM learns a user, not in negotiation tactics.

### What only became possible with frontier models

| Capability | Before frontier models | Now |
| --- | --- | --- |
| Building an inventory | Typing every item by hand, so nobody did it. | A short video becomes a priced, structured Shelf. |
| Knowing what someone wants | Forms and filters, or a human personal shopper. | A 5-minute chat produced rankings that matched people's own on 61% of pairs in Project Swap, above popularity and collaborative filtering baselines. |
| Finding multi-party trades | The matching math existed, but it needed every person to rank every item. | The GM fills in preferences, so the math becomes usable. |
| Coordinating 3 or 4 people | Group chats that die after 2 messages. | Agents run the back-and-forth and only surface decisions. |
| Pricing odd items | Human appraisers, worth it only for expensive goods. | Vision plus comps makes a $40 item worth serving. |

### Competition

| Player | What it does | Why we are different |
| --- | --- | --- |
| [MEER](https://meer.app/) | Personal AI selling agent that lists, prices and haggles on existing marketplaces. | Sells to strangers for cash. We match people who want each other's things. |
| [SellRaze](https://www.ycombinator.com/companies/industry/marketplace/san-francisco-bay-area) (YC F2025) | Camera-to-listing across marketplaces, including its own. | Listing tool. The user still does the selling. |
| [Tradeloops](https://tradeloops.io/) | Local barter network built on multi-party swap chains. | Closest concept. We lead with an agent per user and the Ask, not a listing feed. Needs a close look. |
| SwapMarket, Switcheroo, Bunz | Human-driven swap apps with chat and cash top-ups. | Users browse and negotiate themselves, which is the friction we remove. |
| [Palisade](https://www.ycombinator.com/companies/palisade) (YC S26) | Sales agents that marketplaces embed for their buyers. | Works for the marketplace. Our GM works for the person. |
| Facebook Marketplace with Meta's Muse | Largest local supply plus a personal agent. | Biggest threat. Our defense is trusted Circles, multi-party Loops and a GM that is loyal only to its user. |

### Wedge and growth

- **Invite-only Circles first:** Project Deal and Project Swap both worked inside trusted groups. Density makes matches likely, trust removes most fraud, and handoffs happen in person.
- **Hobby categories first:** Lego, trading cards, video games, sneakers and books already have trading cultures and well-documented prices.
- **Founder seeding:** The founding team seeds Circles with its own Shelf items so the first Ask in a Circle has something to match.
- **Circles connect over time:** Friends of friends and nearby Circles open up later, which grows liquidity without losing trust.

### Business model (post v1)

v1 is free. Later options are a small fee on cash Throw-Ins, a premium GM tier with more autonomy and wider search, and a fee when the GM sources an item from an outside marketplace. Pricing is an open question, not a v1 decision.

## Domain objects and the Ask lifecycle

Everything in the product hangs off 4 objects: the Item on a Shelf, the Ask, the Deal (a 2-party trade or a Loop), and the Handoff that completes it.

| Object | Owned by | What it holds | States |
| --- | --- | --- | --- |
| Circle | Its creator | Members, invite codes, radius, category focus. | active, paused |
| Item | One user | Photos, identification, condition grade, value range, willingness ("would trade", "open to offers", "not available"). | draft, needs\_photos, on\_shelf, reserved, traded, removed |
| Ask | One user | The want in plain words, the resolved target (exact item or a category with constraints), max cash Throw-In, deadline, autonomy level. | drafting, offering, prospecting, proposed, accepted, fulfilled, expired, cancelled |
| Offer set | One Ask | The Shelf items the user is willing to give up for this Ask, plus a cash ceiling. | Edited until the Ask is fulfilled |
| Deal | All participants | Legs (who gives what to whom), Throw-Ins, fairness summary, expiry. | staged, pending\_approvals, approved, scheduling, in\_handoff, completed, failed, cancelled |
| Handoff | Deal participants | Time, place, check-in, both-sides confirmation. | proposed, confirmed, done, no\_show, disputed |
| Taste fact | One user | A typed preference the GM learned, with its source. | active, superseded, deleted |

**Rules that hold everywhere:**

- **An Item can be reserved by only 1 Deal at a time:** Reservation is a database lock, so 2 Loops can never promise the same Lego set.
- **A Deal executes only when every participant approves:** Approval happens on the Deal Sheet in the app, never by typing "yes" in chat.
- **Expiry is mandatory:** Deals expire after 48 hours without full approval, and their Items are released automatically.

&#91;embedded content: Ask lifecycle · 7 steps, 3 recovery paths\]

Every failure path frees the Items and sends the Ask back to work, so a user never sees a dead end.

## End-to-end user experience

The user does 3 things: says what they want, shows what they have, and approves deals. The GM does everything in between.

### First-time experience (target: under 4 minutes to a first Ask)

1. **Invite link:** A friend's link opens the App Store or the app through a universal link and lands on "Jordan invited you to the Thursday Lego Circle."
2. **Sign in:** Sign in with Apple in 1 tap, plus a passkey for later sign-ins. We ask for first name and a profile photo, nothing else.
3. **Meet your GM:** A short chat, not a form. The GM asks what you are into, what you are hunting for, what you would never trade, and how hands-off you want it to be. Target 3 to 5 minutes, since longer intakes measurably improved preference accuracy in Project Swap.
4. **First Ask:** The GM ends the intake with "What's 1 thing you want right now?" so the user leaves onboarding with a live Ask.
5. **What would you offer:** The GM asks the user to film a shelf or snap 2 or 3 items. Items appear as cards with value ranges within about 20 seconds of upload.
6. **Calibration check:** The GM shows 3 sample decisions ("I'd trade your Zelda game for this, but not for that") and a 1-paragraph recap of what it heard. The user corrects anything wrong. This is the trust moment, because users who said the recap missed nothing would delegate more in Project Swap.
7. **Push permission:** Asked only after the first Ask exists, framed as "I'll ping you when I find a deal."

### Posting an Ask

1. **Say it any way:** Text, voice, a screenshot, or a link. "The Lego Batman Batmobile, the big one" is enough.
2. **The GM resolves it:** It identifies the exact item or asks 1 question at most ("the 2024 Tumbler or the 1989 Batmobile?"), then shows a price anchor: retail and typical used price.
3. **The GM asks what you would offer:** It suggests Shelf items that roughly cover the value, and the user taps to include or exclude. A cash ceiling slider sets the max Throw-In.
4. **Autonomy setting:** "Bring me every deal" or "Only bring me deals I'm likely to accept." v1 never executes without approval.
5. **Prospecting starts:** The Ask card shows live status in plain words: "Checking 46 Shelves in 2 Circles." No spinner without words.

### When someone else's Ask matches your Shelf

The GM sends a notification such as "Maya is looking for a Switch game you have. Want me to see what she'd trade?" Tapping it opens a short card. The user can say yes, no, or "not that item," and the GM learns from the answer.

### The Deal Sheet

Every Deal reaches the user as a Deal Sheet, never as a chat message. It shows:

- **What you give and what you get:** Photos, condition grades and value ranges for both sides.
- **The fairness line:** "You give about $70 in value and get about $85," with the Throw-In if any.
- **Who is involved:** All participants in a Loop, with Circle and rating, so a 4-person trade never feels like a black box.
- **Why the GM likes it:** 1 or 2 sentences tied to what the user said ("You said you'd give up the Zelda game for any Batman set").
- **Actions:** Approve, Decline, or "Counter," which opens a small form for a different Throw-In or item. A counter re-runs matching instead of starting a chat thread.

### Handoff and after

1. **Scheduling:** Once all participants approve, the GM proposes 2 or 3 time and place options that work for everyone, using public places or the Circle's default spot (for example an office lobby).
2. **Day of:** A reminder 2 hours before. Each person checks in when they arrive.
3. **Inspect and confirm:** Both people confirm on their phones. Either person can walk away if an item is not as described, and the Deal is marked failed without penalty to the honest party.
4. **Throw-In settles:** Cash Throw-Ins are authorized at approval and captured only when the receiving side confirms.
5. **Close the loop:** The new item is added to the user's Shelf automatically, the Ask is marked fulfilled, and each person rates the other in 1 tap.

### Screens

| Screen | Purpose |
| --- | --- |
| Home | Active Asks with live status, Deal Sheets waiting for you, and 1 suggestion from the GM. |
| GM chat | Conversation with your agent. Responses render as cards (items, Deal Sheets, comparisons), not walls of text. |
| Shelf | Grid of your Items with value ranges and willingness toggles. Capture button opens camera. |
| Capture | Photo, multi-photo and 15 to 60 second video modes, with live guidance ("Show the tag"). |
| Item detail | Photos, identification, condition notes, value history, edit and remove. |
| Ask detail | Target, offer set, cash ceiling, status timeline, candidate deals. |
| Deal Sheet | Approve, decline or counter. |
| Handoff | Time, place, map, check-in, confirm. |
| Circles | Members, invite, Circle settings. |
| Activity log | Everything your GM did and why, with links to each Deal. |
| Profile and settings | Ratings, taste facts (view, edit, delete), notifications, account deletion. |

### Notifications

| Notification | When | Action buttons |
| --- | --- | --- |
| Deal ready | A Deal Sheet is waiting for you. | View |
| Someone wants your item | Another Ask matches your Shelf. | Open, Not this item |
| Approval nudge | A Loop is waiting only on you, after 12 hours. | View |
| Handoff reminder | 2 hours before a handoff. | Directions, Running late |
| Ask update | Weekly, only if nothing has happened, with 1 suggestion to widen the Ask. | Open |

Notifications are capped at 3 per day per user, and promotional pushes require an explicit opt-in, as App Store guideline 4.5.4 requires.

## Agent architecture

Each user gets 1 GM agent that owns the conversation, a few narrow background workers do self-contained jobs, and a deterministic matcher, not an LLM, decides which trades are possible. The model proposes; code enforces.

&#91;embedded content: system architecture · 9 components\]

The GM and background agents call Claude, but only the matcher and server-side checks decide which trades exist and when they execute.

### Design principles

- **1 agent with skills, not a subagent per domain:** Anthropic's commerce guidance found a single agent loop with on-demand skills beat both a single giant prompt and per-domain subagents on quality, cost and latency, because every handoff loses state ([anatomy of commerce agents](https://claude.com/blog/the-anatomy-of-effective-commerce-agents)). The GM is that agent.
- **Subagents only for self-contained work:** Appraising a video or scanning the network for candidates runs in its own context and returns a compact result to the GM.
- **Agents represent, a mechanism clears:** GMs turn conversations into preferences. A matcher service finds the trades. Project Swap found that market design matters less than preference quality, and a central rule removes the haggling arms race and the advantage of stronger agents.
- **Enforcement lives in the harness:** No tool approves a Deal, moves money or releases an Item. Those happen only through app buttons and server checks. Writes accept only IDs the server issued to that session.
- **UI components are tools:** The GM renders cards by calling tools like `present_deal_sheet(deal_id)`. The server fills in every price and photo, so the model cannot invent them.
- **Memory is written in the background:** A separate extractor updates taste facts after turns, so saving never slows a reply.
- **Other people's words are untrusted:** Item descriptions, counter messages and anything another user wrote are sanitized and fenced before any agent reads them.

### Agent roster

| Agent | Job | Trigger | Runtime | Model (start, then tune by evals) |
| --- | --- | --- | --- | --- |
| GM | The user's conversation: intake, Asks, offer sets, explaining Deals, answering questions. | User opens chat or taps a notification. | Our harness on the Messages API with streaming. | `claude-sonnet-5-5` |
| Appraiser | Turns photos and video frames into structured Items with condition and value ranges. | Media upload. | Background job, 1 call per item plus 1 detection call per batch. | `claude-haiku-4-5` for detection and triage, `claude-sonnet-5-5` for identification and pricing |
| Prospector | Turns an Ask into ranked candidate Deals using the matcher plus the user's taste facts. | New Ask, Shelf change in the Circle, or every 6 hours. | Background job with a 2-minute budget per run. | `claude-sonnet-5-5` |
| Liaison | Asks a counterparty's GM structured questions when a candidate Deal needs their input. | Prospector flags a Deal that needs confirmation. | Background job, structured messages only. | `claude-haiku-4-5` |
| Handoff coordinator | Proposes times and places, sends reminders, handles reschedules. | Deal fully approved. | Background job, mostly deterministic. | `claude-haiku-4-5` |
| Memory extractor | Reads finished turns and creates, updates or deletes taste facts. | After each GM turn. | Background job. | `claude-haiku-4-5` |
| Safety screener | Flags prohibited items, recalled products and abusive messages. | Item created, message sent. | Background job plus a synchronous check on publish. | `claude-haiku-4-5` |
| Matcher | Finds feasible 2 to 4-person trades and Throw-Ins. | Called by the Prospector. | Python service, no LLM. | None |

Model IDs follow Anthropic's current guidance: Sonnet 5.5 for everyday agentic work, Haiku 4.5 for high-volume and sub-agent tasks, and Opus 5.5 reserved for offline evaluation grading and hard escalations ([choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)). Pick final models and effort levels by sweeping the eval suite, and measure cost per completed trade, not per call.

### GM tools

| Tool | What it does | Writes? |
| --- | --- | --- |
| `search_my_shelf` | Search the user's own Items. | No |
| `search_network` | Search Items and open Asks in the user's Circles. Returns server-issued IDs only. | No |
| `get_item` | Full detail for an Item ID the session has seen. | No |
| `resolve_target` | Identify an exact product from text, an image or a link, with a price anchor. | No |
| `upsert_ask` | Create or edit the user's Ask. | Yes, own data only |
| `set_offer_set` | Choose which Shelf items and how much cash the Ask may use. | Yes, own data only |
| `update_item` | Edit the user's Item (willingness, notes). | Yes, own data only |
| `get_ask_status` | Current candidates and prospecting progress. | No |
| `stage_counter` | Stage a counter on a Deal. The user confirms in the app. | Staged only |
| `present_items` | Render Item cards. | UI |
| `present_deal_sheet` | Render a Deal Sheet by Deal ID. | UI |
| `present_choices` | Render a multiple-choice question. | UI |
| `request_media` | Open the camera with a specific instruction ("Photo of the box's back"). | UI |
| `load_skill` | Load a skill's instructions as a tool result. | No |

There is deliberately no `approve_deal`, `pay`, `release_item` or `send_message_to_user` tool.

### What lives in the prompt and what lives in skills

The commerce guidance's rule of thumb is to put anything needed on roughly a third or more of turns in the system prompt and the long tail in skills.

- **System prompt:** Grounding rules (prices, availability and condition only from tool results), Deal semantics, presentation rules, safety rules, the user's always-on facts.
- **Skills:** `ask-resolution`, `offer-building`, `deal-explanation`, `handoff-help`, `shelf-coaching`, `safety-escalation`. Each is a short markdown file in the repo, versioned and owned.

### Context and caching

Requests are ordered from most stable to least stable so the prompt cache hits on almost every turn:

1. **Global:** System prompt and tool definitions, identical for all users. Cache breakpoint at the end.
2. **Session:** The user's always-on taste facts, Shelf summary and conversation history. A rolling breakpoint at the latest user turn.
3. **Volatile:** Current time, current screen and any notification that opened the chat, placed last so it never breaks the cache.

The guidance reports that the best commerce deployments run at 90 to 99% cache hit rates, so we track hit rate as a release gate.

### Memory

Taste facts live in Postgres as typed rows (key, value, category, source session, confidence, timestamps), not in a model-side store, because we need to query them in the matcher and let users see and delete them. They are read in 3 layers:

1. **Always in context:** A handful of facts nearly every turn needs, such as categories of interest, never-trade list and default handoff spot.
2. **Pre-fetched per turn:** Facts relevant to the current Ask or screen.
3. **Behind a lookup tool:** Everything else.

The extractor reads only user and GM text, never tool results, so another person's item description cannot become a fact about our user. Writes go through a validator that blocks sensitive categories.

### Agent-to-agent protocol

When a candidate Deal needs a counterparty's input, the Liaison sends structured messages, not free-form chat, to that user's GM.

| Message | Fields |
| --- | --- |
| `inquiry` | Deal ID, the Item requested, what is offered in return, value ranges. |
| `answer` | Accept in principle, decline, or a counter within allowed fields. |
| `counter` | A different Item from the counterparty's offer set, or a different Throw-In. |
| `withdraw` | Any side, any time before approval. |

Limits are enforced in code: at most 3 counter rounds per Deal, a 24-hour response window, and no field that can carry a user's floor or cash ceiling. Free-text fields do not exist, which removes the persuasion tactics the Flybridge experiment saw agents fall for ([When Agent Met Agent](https://lynxcollective.substack.com/p/when-agent-met-agent)). If a counterparty GM is unsure, it asks its own user with a notification instead of guessing.

### Runtime choice

- **v1: our own harness on the Messages API:** The GM is latency-sensitive and needs our database, so we run the loop ourselves with the TypeScript SDK and its tool runner.
- **Later: Claude Managed Agents for long background work:** Managed Agents offers a hosted harness with sessions, memory stores and cron-scheduled deployments ([overview](https://platform.claude.com/docs/en/managed-agents/overview), [scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments)). It is a good fit for sourcing from outside marketplaces later. It is in beta, so it is not on the v1 critical path.

### Is prompting still important?

Less than it used to be, but not zero. Quality now comes mostly from what the agent sees (context), what it can do (tools), the procedures it can load (skills) and the tests it must pass (evals). Prompts become short, versioned policy documents, and every change to them ships with eval cases.

## Item capture and appraisal

A user films a shelf for 15 to 60 seconds and gets back priced Item cards; every estimate is a range with a confidence level, and low confidence triggers a specific follow-up photo request instead of a guess.

### Pipeline

1. **Capture on device:** The app records video or photos. For video, it samples about 1 frame per second plus frames at scene changes, drops blurry frames using on-device Vision blur and quality checks, and keeps at most 30 frames.
2. **Upload:** Frames go to object storage with resumable upload. Claude accepts JPEG, PNG, GIF and WebP images, not video, which is why we send frames ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)).
3. **Detect:** Haiku looks at frames and returns a list of distinct objects with bounding boxes and a rough category. We crop each object from its sharpest frame.
4. **Deduplicate:** The same object seen in 5 frames becomes 1 candidate, using bounding-box overlap across frames and image embeddings.
5. **Identify and grade:** Sonnet receives the crops for each candidate and returns the structured record below, using structured outputs so the JSON always validates.
6. **Price:** The pricing step looks up comparable listings and recent sales, then produces a range. Sources in v1 are web search, eBay's public APIs for active listings, and our own completed trades. Sold-price feeds from marketplaces are usually restricted to approved partners, so treat them as a later partnership.
7. **Ask for what is missing:** If confidence is below 0.7 on identity or condition, the item lands in `needs_photos` with a specific request, such as "Photo of the size tag" or "Photo of the soles."
8. **User confirms:** Items appear as cards. The user can fix the name, mark condition, or remove anything. Corrections are stored as training signal for evals.

### Appraisal output (per Item)

```json
{
  "category": "toys/lego",
  "brand": "LEGO",
  "model": "76240 Batmobile Tumbler",
  "variant": "2021 release",
  "attributes": {"complete": "unknown", "box": true, "manual": true},
  "condition_grade": "B",
  "defects": ["box corner crushed"],
  "age_estimate_years": [2, 4],
  "identity_confidence": 0.86,
  "condition_confidence": 0.62,
  "value_usd": {"low": 180, "mid": 215, "high": 250},
  "value_basis": ["comp:ebay_active:3", "comp:web:2"],
  "follow_up": "Photo of the inside of the box to confirm all bags are present"
}
```

### Condition grades

| Grade | Meaning | Typical evidence |
| --- | --- | --- |
| A | New or like new. | Tags, sealed packaging, no visible wear. |
| B | Lightly used. | Minor wear visible only up close. |
| C | Used. | Clear wear, fully functional. |
| D | Heavily used or flawed. | Damage, missing parts, or stains noted in defects. |

### Rules

- **Ranges, never single numbers:** The UI always shows low to high, which sets honest expectations for trades.
- **No authentication claims:** We never say an item is genuine. We say what the photos show.
- **Embeddings for matching:** Each Item gets an image and text embedding for similarity search. Voyage's `voyage-multimodal-3.5` embeds text, images and video in a shared space, and Anthropic points to Voyage since it does not offer its own embedding model ([embeddings docs](https://platform.claude.com/docs/en/build-with-claude/embeddings)).
- **Cost control:** Downscale crops to about 1000 by 1000 pixels. At that size an image costs about 1,296 visual tokens ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). Use the Files API so images are not resent on every turn.
- **Safety screen on create:** The Safety screener checks every new Item against the prohibited list and recall data before it can appear on a Shelf.

## Matching, prospecting and multi-party deals

Matching works like a kidney exchange: build a graph of who wants what, find short cycles of 2 to 4 people, balance each cycle with small cash Throw-Ins, and pick the set of non-overlapping cycles that makes people happiest.

### The want graph

- **Nodes:** Users, each with an offer set (Items they would give and a cash ceiling).
- **Edge from A to B:** A wants an Item that B is willing to give. Edges carry the Item, A's estimated utility for it, and a confidence level.
- **Explicit edges:** B's Item matches A's posted Ask. These can go straight to a Deal Sheet.
- **Inferred edges:** A's taste facts suggest A would want B's Item, but A never asked. These require a Liaison inquiry to A's GM, which may ask A, before any Deal Sheet is shown.
- **A cycle is a trade:** A to B to C to A means A receives from B, B receives from C, and C receives from A.

### Balancing a cycle with Throw-Ins

For each candidate cycle, a small linear program sets Throw-Ins so that:

1. **Everyone nets close to even:** Each person's value received minus value given, plus cash received minus cash paid, stays within a tolerance of 15% of the larger item value or $10, whichever is greater.
2. **Cash ceilings hold:** Nobody pays more than the cash ceiling on their Ask or offer set.
3. **Cash moved is minimized:** The objective is the least total cash changing hands.

If no solution exists, the cycle is dropped.

### Scoring and selection

Each feasible cycle gets a score: the sum of utility gained by participants, minus a penalty for cash moved, minus a logistics penalty (distance and number of handoffs), minus a risk penalty (low ratings, low condition confidence, inferred edges). The matcher then chooses non-overlapping cycles that maximize total score with an integer program (OR-Tools CP-SAT), so no Item is promised twice.

### 2 modes

| Mode | When | What it optimizes |
| --- | --- | --- |
| Live | A new Ask or a Shelf change. Searches cycles of length 2 to 4 that include the asker, by bounded depth-first search. | The best Deal for this Ask, fast. Target under 10 seconds for a Circle of 200 people. |
| Drop | Once a week per Circle, Sunday morning. Searches all cycles in the Circle. | Total happiness across the Circle, like the clearing in Project Swap. Produces the "you're in a 4-way trade" moment. |

### From candidate to Deal Sheet

1. **Candidate generation:** Vector search matches Ask text and taste facts against Item embeddings within the user's Circles and radius.
2. **Graph and cycles:** The matcher builds edges and searches cycles.
3. **Prospector review:** The LLM checks each top candidate against the user's taste facts and never-trade list, removes anything odd, and writes the 1 or 2-sentence "why" for each participant.
4. **Liaison inquiries:** Inferred edges get structured inquiries. Answers update edge confidence, and the matcher re-runs.
5. **Stage:** The Deal is created in `pending_approvals` and every Item in it is reserved.
6. **Deal Sheets:** Each participant gets their own Deal Sheet, written from their side.
7. **Approvals:** Every participant approves in the app. A decline or a 48-hour timeout releases the Items and triggers a re-match for everyone else.

### Guardrails enforced in code

- **Floors and ceilings never leave the server:** No agent message, Deal Sheet or tool result reveals another user's limits.
- **Parity:** Every user's GM runs the same model and harness, so nobody loses because a rival agent is stronger, which Project Deal showed people often cannot detect on their own.
- **Bounded negotiation:** At most 3 counter rounds per Deal, and counters are structured fields, not text.
- **Rate limits:** Each GM can send at most 20 inquiries per hour, and each user receives at most 5 inquiries per day.
- **Fairness display:** All participants see the same value ranges for every Item in the Loop.
- **No dead ends:** If an Ask finds nothing in 72 hours, the GM suggests a concrete way to widen it, such as adding an Item to the offer set or raising the cash ceiling.

## Data model and storage

All product data lives in 1 Postgres database (Supabase) with pgvector for embeddings and row-level security on every user-owned table; media lives in object storage, and every agent action is written to an append-only event log.

### Tables

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, apple\_sub, display\_name, photo\_url, created\_at, deleted\_at | Mirrors Supabase `auth.users`. Soft delete, then hard delete within 30 days. |
| `profiles` | user\_id, home\_area (coarse geohash), default\_handoff\_place\_id, autonomy\_level, notification\_prefs | Never store exact home address. |
| `circles` | id, name, owner\_id, radius\_km, category\_focus, status |  |
| `circle_members` | circle\_id, user\_id, role, joined\_at | Role is owner, member. |
| `invites` | code, circle\_id, created\_by, max\_uses, uses, expires\_at | Universal link carries the code. |
| `items` | id, owner\_id, status, category, brand, model, variant, attributes jsonb, condition\_grade, defects text\[\], value\_low, value\_mid, value\_high, identity\_conf, condition\_conf, willingness, reserved\_by\_deal\_id | `reserved_by_deal_id` with a unique partial index enforces 1 Deal per Item. |
| `item_media` | id, item\_id, storage\_path, kind (photo, frame), width, height, sharpness, crop\_box |  |
| `item_embeddings` | item\_id, model, embedding vector(1024) | HNSW index. |
| `appraisals` | id, item\_id, model, input\_media\_ids, output jsonb, comps jsonb, created\_at | Full history for evals and disputes. |
| `asks` | id, user\_id, raw\_text, target jsonb, status, cash\_ceiling\_cents, deadline, autonomy |  |
| `offer_sets` | ask\_id, item\_id | Which Items this Ask may use. |
| `taste_facts` | id, user\_id, key, value, category, source\_session\_id, confidence, status, created\_at, updated\_at | User-visible and deletable. |
| `edges` | id, from\_user, to\_user, item\_id, ask\_id, utility, confidence, kind (explicit, inferred), computed\_at | Rebuilt by the matcher, safe to truncate. |
| `deals` | id, mode (live, drop), status, created\_by\_run\_id, expires\_at, fairness jsonb |  |
| `deal_legs` | deal\_id, giver\_id, receiver\_id, item\_id, throw\_in\_cents | 1 row per transfer. |
| `deal_participants` | deal\_id, user\_id, approval (pending, approved, declined), approved\_at, sheet\_snapshot jsonb | Snapshot of exactly what the user approved. |
| `liaison_messages` | id, deal\_id, from\_user, to\_user, type, payload jsonb, created\_at | Structured protocol only. |
| `handoffs` | id, deal\_id, place\_id, starts\_at, status, checkins jsonb |  |
| `payments` | id, deal\_id, payer\_id, payee\_id, amount\_cents, stripe\_payment\_intent, status | Authorized at approval, captured at confirm. |
| `ratings` | deal\_id, rater\_id, ratee\_id, score, note |  |
| `reports` and `blocks` | reporter\_id, target\_user\_id, target\_item\_id, reason, status | Required for App Store guideline 1.2. |
| `conversations` and `messages` | id, user\_id, role, content jsonb, tool\_calls jsonb, created\_at | GM chat history in API-native format. |
| `agent_runs` | id, agent, trigger, user\_id, ask\_id, model, input\_tokens, output\_tokens, cache\_read\_tokens, cost\_cents, latency\_ms, outcome | One row per agent invocation. |
| `agent_events` | id, run\_id, type, payload jsonb, created\_at | Append-only. Every tool call and result. Powers the user-facing activity log and evals. |
| `notifications` | id, user\_id, kind, payload, sent\_at, opened\_at |  |

### Storage and access rules

- **Row-level security everywhere:** Users read and write their own rows. Network reads go through server endpoints and database functions that return only fields safe to share, never raw rows.
- **Media:** Private buckets with signed URLs that expire after 1 hour. Original videos are deleted after frames are extracted.
- **Server-issued IDs:** The harness keeps a per-session set of IDs it has returned to the model, and every write and render tool rejects IDs outside that set.
- **Deletion:** Account deletion removes items, media, taste facts, conversations and embeddings, and anonymizes completed deals for the other participants' records.

## API design

The iOS app talks to 1 versioned REST API plus a streaming endpoint for the GM; agents never call the public API, they call internal tool functions with the same server-side checks.

### Public endpoints (v1)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/auth/session` | Exchange a Sign in with Apple ID token for a session (handled by Supabase Auth). |
| GET | `/v1/me` | Profile, autonomy level, counts. |
| PATCH | `/v1/me` | Update profile and preferences. |
| DELETE | `/v1/me` | Start account deletion. |
| GET | `/v1/me/taste-facts` | List what the GM has learned. |
| DELETE | `/v1/me/taste-facts/{id}` | Delete a fact. |
| POST | `/v1/circles` | Create a Circle. |
| POST | `/v1/circles/{id}/invites` | Create an invite code. |
| POST | `/v1/invites/{code}/accept` | Join a Circle. |
| POST | `/v1/media/uploads` | Get signed upload URLs for frames or photos. |
| POST | `/v1/captures` | Submit uploaded media for appraisal. Returns a capture ID. |
| GET | `/v1/captures/{id}` | Appraisal progress and resulting draft Items. |
| GET | `/v1/items` | The user's Shelf. |
| PATCH | `/v1/items/{id}` | Edit an Item (confirm, fix name, willingness). |
| DELETE | `/v1/items/{id}` | Remove from Shelf. |
| POST | `/v1/asks` | Create an Ask from text, image or link. |
| GET | `/v1/asks/{id}` | Ask detail, status timeline, candidate count. |
| PATCH | `/v1/asks/{id}` | Edit target, offer set or cash ceiling. |
| GET | `/v1/deals/{id}` | Deal Sheet for the current user. |
| POST | `/v1/deals/{id}/approve` | Approve. Requires a fresh device-bound confirmation (Face ID or passkey). |
| POST | `/v1/deals/{id}/decline` | Decline with an optional reason. |
| POST | `/v1/deals/{id}/counter` | Submit a structured counter. |
| POST | `/v1/handoffs/{id}/confirm-slot` | Pick a proposed time and place. |
| POST | `/v1/handoffs/{id}/checkin` | Arrived. |
| POST | `/v1/handoffs/{id}/complete` | Confirm received as described. |
| POST | `/v1/handoffs/{id}/dispute` | Not as described or no-show. |
| POST | `/v1/ratings` | Rate a counterparty. |
| POST | `/v1/reports` and `/v1/blocks` | Report or block a user or Item. |
| GET | `/v1/activity` | The GM's activity log for this user. |

### GM conversation

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/gm/messages` | Send a user message (text, image IDs, or a screen context). Returns a stream ID. |
| GET | `/v1/gm/stream/{id}` | Server-sent events: text deltas, tool progress lines ("Checking 46 Shelves"), and UI component events (`item_cards`, `deal_sheet`, `choices`, `camera_request`). |

UI component events carry IDs plus server-filled data, and the client renders them natively in SwiftUI. Because they are tool calls in the message history, reloading an old conversation renders the same cards without re-parsing text.

### Realtime and webhooks

- **Realtime channels:** Per-user channels push Ask status changes, new Deal Sheets and handoff updates to an open app.
- **Push:** APNs for the notifications listed in the user experience section, with action buttons.
- **Stripe webhooks:** Payment authorization, capture, failure and dispute events update `payments` and the Deal state.
- **Idempotency:** Every POST that changes state accepts an `Idempotency-Key` header, since mobile networks retry.

## iOS app

The app is native SwiftUI, targets iOS 17 and later, and keeps no secrets on device: every model call goes through our server.

### Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| UI | SwiftUI with the Observation framework | iOS 17 minimum for `@Observable`. |
| Language | Swift 6 with strict concurrency |  |
| Backend client | [supabase-swift](https://github.com/supabase/supabase-swift) for auth, database reads, storage and realtime | Our own REST client for `/v1` endpoints. |
| Auth | Sign in with Apple through Supabase native ID-token sign-in, passkeys for return visits | [Supabase Apple guide](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/social-login/auth-apple.mdx) |
| Camera | AVFoundation capture session for video, PhotosPicker for library, VisionKit for live text on tags |  |
| On-device checks | Vision framework for blur and quality, before upload | Saves upload time and model cost. |
| Payments | Stripe iOS SDK with Apple Pay | Physical goods must not use in-app purchase. |
| Push | APNs with notification categories and action buttons |  |
| App integrity | App Attest through DeviceCheck on every authenticated request | Limits scripted abuse of the API. |
| Local storage | SwiftData cache for Shelf and Asks, Keychain for tokens | Works offline for browsing. |
| Links | Universal links for invites and Deal Sheets |  |
| Analytics | Privacy-respecting product analytics, no ad tracking | No App Tracking Transparency prompt needed. |

### Project structure

```text
ThrowIn/
  App/            App entry, routing, dependency container
  Features/
    Onboarding/   Invite landing, sign in, GM intake, calibration
    GM/           Chat view, streaming client, component renderers
    Shelf/        Grid, item detail, capture flow
    Asks/         Ask list, detail, offer set editor
    Deals/        Deal Sheet, counter form, approvals
    Handoffs/     Scheduling, map, check-in, confirm
    Circles/      Members, invites
    Settings/     Profile, taste facts, notifications, delete account
  Core/
    API/          REST client, SSE client, models (Codable)
    Auth/         Apple sign in, passkeys, session
    Media/        Capture, frame sampling, upload queue
    Design/       Colors, type, components
  Tests/
```

### App Store requirements we must meet

| Requirement | Guideline | How we meet it |
| --- | --- | --- |
| Filter, report, block and published contact info for user content | 1.2 | Safety screener on Items and messages, report and block on every profile and Item, support email in app and metadata. |
| Physical goods paid outside in-app purchase | 3.1.3(e) | Throw-Ins use Apple Pay or card through Stripe. |
| Equivalent privacy-focused login if we add Google or similar | 4.8 | v1 uses Sign in with Apple only. |
| In-app account deletion | 5.1.1(v) | Settings has Delete account, backed by `DELETE /v1/me`. |
| Disclose sharing with third-party AI and get permission | 5.1.2(i) | Onboarding explains that photos and messages are processed by Anthropic's models, with an explicit consent step. |
| Explicit opt-in for promotional pushes | 4.5.4 | Transactional pushes only by default. |
| Demo account for review | 2.1(a) | A seeded review account in a review-only Circle. |

Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), last updated June 8, 2026.

## Backend, infrastructure and evals

The backend is a small monorepo: a TypeScript API and agent harness, a Python matcher, Postgres on Supabase, and a job queue; evals run in CI on every change to a prompt, skill or tool.

### Services

| Service | Language | Responsibility |
| --- | --- | --- |
| `api` | TypeScript (Node, Hono or Fastify) | Public `/v1` REST, auth checks, idempotency, Stripe webhooks. |
| `harness` | TypeScript with the Anthropic SDK | GM loop, tool execution, streaming, caching, ID allow-lists, sanitizer. |
| `workers` | TypeScript | Appraiser, Prospector, Liaison, Handoff coordinator, Memory extractor, Safety screener. |
| `matcher` | Python with OR-Tools | Graph build, cycle search, Throw-In balancing, set selection. Stateless HTTP service. |
| `db` | Supabase Postgres with pgvector | Source of truth, row-level security, realtime. |
| `queue` | Postgres-backed queue (for example pg-boss) | Background jobs with retries, keeps v1 to 1 database. |
| `storage` | Supabase Storage | Media, private buckets. |

### Repository layout

```text
throwin/
  apps/ios/                 SwiftUI app
  services/api/             Public REST API
  services/harness/         GM agent loop and tools
  services/workers/         Background agents
  services/matcher/         Python matching service
  packages/shared/          Types, schemas, ID allow-list, sanitizer
  agents/
    gm/system.md            System prompt (versioned)
    gm/skills/*.md          Skills loaded on demand
    appraiser/              Prompts and output schemas
  evals/
    cases/                  Snapshot cases (state + message + expected outcome)
    runner/                 Eval runner and graders
  supabase/migrations/      SQL migrations and RLS policies
  CLAUDE.md                 Conventions for Claude Code
```

### Observability

- **Per-run records:** Every agent call writes model, tokens, cache reads, cost, latency and outcome to `agent_runs`.
- **Traces:** Every tool call and result goes to `agent_events`, linked to the user, Ask and Deal.
- **Dashboards:** Cost per fulfilled Ask, cache hit rate, appraisal confidence distribution, Deal approval rate, handoff completion rate.
- **Alerts:** Error rate, p95 GM latency over 8 seconds, cache hit rate under 85%, any write rejected by the ID allow-list (possible injection).

### Evals

Following Anthropic's commerce guidance, eval cases are snapshots: a constructed database state and conversation, a new user message, and a grade on the outcome (final state and rendered components), not on the path the agent took ([anatomy of commerce agents](https://claude.com/blog/the-anatomy-of-effective-commerce-agents)).

| Suite | Examples | Starting size |
| --- | --- | --- |
| Intake and calibration | Does the GM's ranking of 10 sample Items match the user's own ranking? This mirrors Project Swap's pairwise agreement measure. | 50 personas |
| Ask resolution | Vague and exact Asks resolve to the right target, with at most 1 clarifying question. | 100 |
| Appraisal | Identity, condition and value range against hand-labeled Items, including tough photos. | 300 Items |
| Grounding | Every price and condition in a reply traces to a tool result. | 50 |
| Deal explanation | The "why" is true to the user's stated preferences and never reveals another user's limits. | 50 |
| Safety | Injections planted in other users' item descriptions, attempts to read another user's data, prohibited items. Each positive case has a negative twin. | 100 |
| Matcher | Property tests: no Item in 2 Deals, Throw-Ins within ceilings, every cycle balanced. | Generated |

**CI gates:** A pull request that touches a prompt, skill or tool runs the core set plus the cases for what changed, over 3 trials. The full suite runs nightly and before every release. Gates cover pass rate, cache hit rate and cost per turn.

### Environments and secrets

Dev, staging and prod Supabase projects. The Anthropic, Voyage and Stripe keys live only on the server, in the hosting provider's secret store. Staging uses Stripe test mode and a seeded synthetic Circle of 200 users for load and eval runs.

### Rough cost per user (approximate, to validate)

The biggest costs are appraisal images and GM turns. A 1000 by 1000 pixel image is about 1,296 visual tokens, so appraising 20 Items with 2 crops each is roughly 50,000 image tokens before text. With caching at 90% or better on GM turns, a typical active user should cost well under $1 per month in model calls, but this must be measured in the pilot, not assumed.

## Trust, safety, privacy and legal

v1 keeps risk low by design: invite-only Circles, adults only, in-person handoffs where both sides inspect before confirming, and no custody of goods. This section is a product checklist, not legal advice, and every legal item needs counsel before launch.

### Trust and safety controls

| Risk | Control |
| --- | --- |
| Item not as described | Both sides confirm on their phones at the handoff and can walk away. Cash is captured only after confirmation. |
| No-shows | Check-ins and a no-show report. 2 no-shows pause a user's Asks for 14 days. |
| Scams and fake accounts | Invite-only Circles, Sign in with Apple, App Attest, and ratings shown on every Deal Sheet. |
| Unsafe meetups | Public places or the Circle's default spot only, daytime suggestions first, and a "share my handoff" link. |
| Prohibited or dangerous items | Safety screener on Item creation, a published prohibited list (weapons, alcohol, drugs, recalled products, counterfeits, live animals), and report and block. |
| Recalled products | Check Items against recall data before publishing, which matters most for kids' gear. |
| Prompt injection through other users' text | All third-party text is sanitized and fenced, agents treat it as data, and writes accept only server-issued IDs. |
| Agent quality gaps | Every GM runs the same model and harness, and a central matcher decides trades. |
| Harassment | Structured agent messages, report and block, and no open DMs in v1. |

### Privacy

- **Data minimization:** No exact home address, only a coarse area and chosen handoff places.
- **Third-party AI disclosure:** Onboarding states that photos and messages are processed by Anthropic's models and asks for consent, as App Store guideline 5.1.2(i) requires.
- **Memory controls:** Users can see, edit and delete every taste fact. The extractor never stores health, financial or other sensitive categories, enforced by a write validator.
- **Retention:** Original videos are deleted after frame extraction. Conversations and taste facts follow a set retention period, and everything is deleted with the account.
- **California privacy law:** We are based in California, so the privacy policy and data-request flows need to meet state requirements. Confirm with counsel.

### Legal questions for counsel

| Topic | Why it matters |
| --- | --- |
| Barter exchange reporting | The IRS generally treats organized barter exchanges as having reporting duties (Form 1099-B). Confirm whether Throw-In's trades qualify. |
| Money handling | Throw-Ins run through Stripe Connect so we do not hold funds ourselves, which avoids money transmitter licensing. Confirm the setup. |
| Agent authority | Electronic-transaction laws generally recognize automated agents forming contracts. Terms must state that the GM proposes and only the user approves. |
| Marketplace liability | Terms of service, dispute policy, prohibited items list and a statement that we do not authenticate goods. |
| Recalled products | Federal consumer product safety law prohibits selling recalled products, and trades may be treated the same way. |
| Minors | v1 is 18 and over, because of in-person meetups and children's privacy law. |

## Metrics and experiments

The north star is fulfilled Asks per active user per month: a user wanted something and got it through a completed trade.

### Metrics

| Metric | Definition | Why it matters | Pilot target (to set, not a forecast) |
| --- | --- | --- | --- |
| Fulfilled Asks per active user | Asks that end in a completed handoff, per user per month. | North star. | 1 or more in a Circle of 30 |
| Time to first trade | Days from sign-up to first completed handoff. | Shows whether the magic arrives before interest fades. | Under 14 days |
| Preference agreement | Share of item pairs where the GM's ranking matches the user's own. | Project Swap's core measure of whether the agent understands people. | Above 61% |
| Recap accuracy | Share of users who say the GM's recap missed nothing. | Predicted willingness to delegate in Project Swap. | Above 70% |
| Deal approval rate | Deal Sheets approved by every participant, out of all sent. | Quality of matching and explanations. | Above 40% |
| Loop rate | Completed Deals with 3 or more people. | Proof the product does something marketplaces cannot. | Above 20% |
| Handoff completion | Approved Deals that finish with both confirmations. | Trust and logistics. | Above 85% |
| Dispute rate | Handoffs ending in "not as described." | Appraisal honesty. | Under 3% |
| Unprompted Shelf adds | Items added without a prompt, per user per month. | Retention signal. | 2 or more |
| Invites per user | Invites sent that convert to a member. | Liquidity growth. | 1 or more |
| Cost per fulfilled Ask | Model and infrastructure cost divided by fulfilled Asks. | Unit economics. | Measure first |

### First experiments

- **Intake length:** A 3-minute intake versus a 6-minute intake, measured on preference agreement and first-week approval rate.
- **Recap and sample decisions:** Showing the calibration step versus skipping it, measured on approval rate and autonomy setting chosen.
- **Live versus weekly drop:** Matching on every Ask versus a weekly Circle-wide drop, measured on Loop rate and satisfaction.
- **Throw-In tolerance:** A 10% fairness tolerance versus 20%, measured on approval rate and dispute rate.
- **Category focus:** A Lego-only Circle versus a mixed-category Circle, measured on fulfilled Asks.

## Build plan for Claude Code

Build in 7 milestones, each ending in something a person can use on a phone, and give Claude Code 1 milestone at a time with its acceptance criteria as the definition of done.

### Milestone 0: Foundations

- [ ] Create the monorepo layout from the backend section and a `CLAUDE.md` (starter below).
- [ ] Create Supabase dev and staging projects, enable pgvector, and write migrations for every table in the data model with row-level security.
- [ ] Build the iOS shell: tab bar, routing, design system, Sign in with Apple through Supabase, passkey enrollment.
- [ ] Stand up `api` with `/v1/me`, idempotency middleware and App Attest verification.
- [ ] Set up CI: Swift build and tests, TypeScript lint and tests, Python tests, migration checks.

**Done when:** A new user can sign in with Apple on a real device, see an empty Shelf, and delete their account.

### Milestone 1: Shelf and appraisal

- [ ] Capture flow with photo and video modes, frame sampling, blur filtering and resumable upload.
- [ ] Appraiser worker: detection, deduplication, identification and grading with structured outputs, pricing with comps, follow-up photo requests.
- [ ] Item cards with value ranges, edit, willingness toggles and remove.
- [ ] Item embeddings written on create.
- [ ] Appraisal eval suite with 100 hand-labeled Items to start.

**Done when:** Filming a shelf of 10 items produces at least 8 correct Items with ranges in under 60 seconds, measured on the eval set.

### Milestone 2: GM and Asks

- [ ] Harness: agent loop on the Messages API, streaming over SSE, tool registry, server-issued ID allow-list, sanitizer and fences, prompt caching with rolling breakpoints.
- [ ] GM system prompt and the 6 skills, versioned in `agents/gm/`.
- [ ] UI component tools rendered natively in SwiftUI: item cards, choices, camera request.
- [ ] Intake conversation, recap and 3 sample decisions.
- [ ] Ask creation from text, image and link, with offer set and cash ceiling.
- [ ] Memory extractor with the write validator, plus the taste facts screen in Settings.

**Done when:** A new user finishes intake, posts an Ask and sets an offer set in under 4 minutes, and the grounding and intake evals pass.

### Milestone 3: Matching and Deal Sheets

- [ ] Matcher service: graph build, bounded cycle search up to length 4, Throw-In linear program, CP-SAT selection, property tests.
- [ ] Prospector worker with the 2-minute budget, live mode on Ask and Shelf changes, weekly drop mode.
- [ ] Liaison worker and the structured protocol with round and rate limits.
- [ ] Deal staging with Item reservation, per-participant Deal Sheets, approve, decline and counter endpoints, 48-hour expiry.

**Done when:** In a seeded staging Circle of 200 synthetic users, live matching returns a Deal in under 10 seconds, no Item is ever in 2 pending Deals, and the deal explanation and safety evals pass.

### Milestone 4: Handoffs and Throw-Ins

- [ ] Handoff coordinator: slot proposals, confirmation, reminders, check-in, complete and dispute.
- [ ] Stripe Connect onboarding, Apple Pay authorization at approval, capture at confirmation, webhooks.
- [ ] Ratings, and automatic Shelf add of received Items.
- [ ] Push notifications with action buttons and a cap of 3 per day.

**Done when:** 3 test users complete a 3-person Loop with a cash Throw-In end to end on real devices in Stripe test mode.

### Milestone 5: Safety and launch readiness

- [ ] Safety screener, prohibited list, recall check, report and block flows.
- [ ] Activity log screen backed by `agent_events`.
- [ ] Third-party AI consent step, privacy policy and terms links.
- [ ] Full eval suite in CI with gates, nightly runs, dashboards and alerts.
- [ ] App Store review account and TestFlight build.

**Done when:** The app passes an internal review against every row of the App Store requirements table, and all eval gates are green.

### Milestone 6: Pilot

- [ ] Seed 1 Circle of 20 to 30 people in 1 hobby category, with founder Items on Shelves.
- [ ] Run 2 weekly drops plus live matching for 4 weeks.
- [ ] Review every metric in the metrics table each week, and turn every failure into an eval case.

**Done when:** We can answer whether people got things they wanted, whether they invited others, and what a fulfilled Ask costs.

### CLAUDE.md starter

```markdown
# Throw-In

An iOS app where each user's GM agent turns Asks into trades with people in their Circles.

## Non-negotiables
- The model proposes, the server enforces. No tool may approve a Deal, move money, or release an Item.
- Write and render tools accept only IDs the server returned to this session.
- All text written by other users is untrusted: sanitize and fence it before any agent sees it.
- Prices, conditions and availability in agent output must come from tool results.
- Every prompt, skill or tool change ships with eval cases in evals/cases/.

## Stack
- iOS: SwiftUI, Swift 6, iOS 17+, supabase-swift.
- Backend: TypeScript (api, harness, workers), Python (matcher), Supabase Postgres with pgvector.
- Models: claude-sonnet-5-5 for the GM and pricing, claude-haiku-4-5 for detection and background workers.

## Commands
- iOS build and test, backend lint and test, matcher tests, eval runner: fill in as they are created.
```

## Open questions and risks

The biggest risk is liquidity: a Circle of 30 people may not have enough overlapping wants to produce trades every week, and everything else is secondary to finding that out in the pilot.

| Risk or question | Why it matters | How we find out or reduce it |
| --- | --- | --- |
| Thin liquidity in small Circles | No matches means no magic moment. | Start in 1 hobby category, seed founder Items, and track fulfilled Asks per Circle weekly. |
| Value mismatch between Items | An iPhone and a $2 book never match. | Cash Throw-Ins, offer sets with several Items, and a fairness tolerance tested in experiments. |
| Meta's Muse plus Facebook Marketplace | Could ship "trade for me" with far more supply. | Own trusted Circles, multi-party Loops and a GM loyal only to its user. |
| Tradeloops and swap apps | Similar ideas already exist. | Study Tradeloops closely, and compete on the agent and the Ask rather than a listing feed. |
| Appraisal errors | Wrong values erode trust fast. | Ranges, confidence thresholds, follow-up photos, and in-person inspection before confirming. |
| Users do not trust autonomy | Approvals become a chore. | Calibration step, activity log, and autonomy that users raise themselves over time. |
| Barter tax reporting | Could add real compliance work. | Counsel review before public launch. |
| Managed Agents is in beta | Background features could shift. | Keep v1 on our own harness. |
| Name availability | Throw-In may be taken or hard to trademark. | Trademark search and App Store name check before any branding work. |

**Decisions still open:**

- [ ] Final name.
- [ ] Pilot category: Lego, sneakers, or video games.
- [ ] Whether the first pilot runs only weekly drops or also live matching.
- [ ] Fee model after v1.

## Sources

- [Project Swap: What happens when agents trade for us? (Anthropic)](https://www.anthropic.com/research/project-swap)
- [Project Deal: our Claude-run marketplace experiment (Anthropic)](https://www.anthropic.com/features/project-deal)
- [A guide to the anatomy of effective commerce agents (Claude blog)](https://claude.com/blog/the-anatomy-of-effective-commerce-agents)
- [Commerce agent use case guide (Claude docs)](https://platform.claude.com/docs/en/about-claude/use-case-guides/commerce-agents)
- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Managed Agents multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration)
- [Managed Agents memory stores](https://platform.claude.com/docs/en/managed-agents/memory)
- [Managed Agents scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments)
- [Choosing the right model (Claude docs)](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
- [Vision (Claude docs)](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Embeddings (Claude docs)](https://platform.claude.com/docs/en/build-with-claude/embeddings)
- [When Agent Met Agent (Flybridge)](https://lynxcollective.substack.com/p/when-agent-met-agent)
- [App Review Guidelines (Apple)](https://developer.apple.com/app-store/review/guidelines/)
- [supabase-swift (GitHub)](https://github.com/supabase/supabase-swift)
- [Sign in with Apple with Supabase](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/social-login/auth-apple.mdx)
- [ThredUp 2026 Resale Report coverage (WWD)](https://wwd.com/sustainability/business/thredup-2026-resale-report-secondhand-growth-1238871192/)
- [MEER](https://meer.app/)
- [Tradeloops](https://tradeloops.io/)
- [Palisade (YC)](https://www.ycombinator.com/companies/palisade)
