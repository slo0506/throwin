# Agents, background work and agent-to-agent trading

Oct 6, 2026, with Sean's decisions of Oct 7. What Throw-In's agents do when you're not looking, how 2 GMs will trade on their users' behalf, how we keep it safe, and what's left to build. Product behavior defers to `docs/prd.md`; this spec fills in what the PRD leaves open and records Sean's decisions.

## Principles (from the research)

| Lesson | Source | What we do |
| --- | --- | --- |
| Understanding people explains most of the gap; negotiation explains little. | Project Swap (85% vs 15% of the efficiency gap) | Invest in intake, taste facts and the recap. GMs don't haggle: a deterministic matcher clears trades. |
| Users can't tell when their agent is weaker. | Project Deal | Every GM runs the same model and harness (parity). Fairness is computed, shown in ranges, never argued. |
| Agents confabulate. | Project Deal | Prices, condition and availability only from tool results (grounding check). |
| A decoupled monitor that reviews every action beats trusting the actor. | Noah Shinn (Instinct), Invest Like the Best | The model proposes, the server enforces: ID allow-lists, no approve, pay or release tools, code checks behind every prompt rule. |
| 1 long thread gets noisy; people want a thread per job. | Instinct | Several GM conversations, the main 1 pinned (#43). |
| An agent shared a seller's home address and booked a visit unasked. | Meta Muse incident | No tool can share contact details or commit to a meetup. Handoffs need every person's confirmation in the app, at public places or the Circle's spot. |

## What the agents do in the background

Everything an agent does reaches the user in 1 of 4 places: **Next up** on Home (what needs you, #42), the **Ask page** status line, **notifications** (Milestone 4, capped at 3 a day), and the **activity log** (Milestone 5: everything, with reasons).

| Behavior | Agent | Trigger | What you see | Status |
| --- | --- | --- | --- | --- |
| Name, grade and price new photos | Appraiser | Upload | A card that scans while the GM reads it, then lands priced | Built |
| Pin down what an Item is, cheapest question first | Refiner | Item created, answer, new photos | Tune up, the product page's GM card | Built |
| Grade photos and ask for the missing angles | Refiner | Item created, new photos | "2 photos and it's ready to show", with coaching | Built |
| Learn your taste | Memory extractor | After each GM turn | You → What your GM knows | Built |
| Look for trades for every Ask | Prospector + matcher | New Ask, offer change, every 6 hours | Ask status line, Next up, Deal Sheets | Built |
| Clear the whole Circle, 3 and 4-way Loops included | Prospector + matcher | Sunday 9am Pacific | "You're in a 4-way trade" | Built |
| Ask for showcase photos when someone's waiting | Prospector | A staged Deal includes your unready Item | "Bob wants your LEGO Typewriter. 1 photo and the deal can go out." | In Next up (#42); push in M4 |
| Tell you when someone wants your Item | Prospector → Liaison | Another Ask matches your Item | "Maya is looking for your Zelda": pick what you'd take from her offer | In Next up; push in M4 |
| Ask the other GM when a trade rests on a guess | Liaison | A Loop needs an inferred edge | "Would a PS5 work instead of an Xbox?" | Not built (M3) |
| Spot trades 1 Item away (brokering) | Prospector (drop) | Weekly | "You could make a 3-way happen with Kobe 11s" | Proposed |
| Keep values fresh | Refiner | Weekly, for Items in active offers | Ranges move; the Ask page fit updates | Proposed |
| Nudge on what's stuck | Notifier | Approval waiting 12 hours, quiet Ask for a week | Push with actions | Not built (M4) |
| Arrange the handoff | Handoff coordinator | Every person approved | 2 or 3 times and places, reminders | Not built (M4) |
| Screen every new Item | Safety screener | Item created | Blocked with a reason | In the Appraiser and GM (#41); the independent screener is M5 |

## Agent-to-agent trading

### Is it built?

Partly. The matcher already finds 2 to 4-person Loops among people's **explicit** wants, balances them with cash Throw-Ins and never promises an Item twice (Milestone 3). Every person gives exactly 1 Item and gets exactly 1, so **bundles** (X for Y) aren't built yet. Neither is anything that needs 2 GMs to talk: the **Liaison**, **inferred edges**, **counters** and **demand signals**. All of it is Milestone 3 work.

So today, if Mary asks for an Xbox and you have a PS5, nothing happens unless her Ask's text happens to match a PS5 closely.

### How it should work: "Mary wants an Xbox; she might take a PS5"

GMs never haggle in free text. They exchange structured messages, the matcher decides what's feasible and fair, and every person approves on a Deal Sheet.

1. **Spot the near-match.** The Prospector scores your PS5 against Mary's Xbox Ask: the same category, a different product, similar value. That's an **inferred edge** (Mary might want it), stored with low confidence. Explicit edges stay as they are.
2. **Let the matcher try it.** The matcher already accepts inferred edges and penalizes them (`inferred_edge` weight). If the best Loop uses 1, it can't be staged yet.
3. **Ask Mary's GM, not Mary.** The Liaison sends an `inquiry`: the Item (its showcase photo and range), the Ask it might fill, and what she'd give in return. It never includes anyone's cash ceiling, floor or limits.
4. **Her GM answers if it can.** Her taste facts may settle it: "any current-gen console" means accept in principle, and "never Sony" means decline. Otherwise her GM asks her once, as a 1-tap card in Next up (and a push in M4): "Would a PS5 work instead of an Xbox?" with the options Yes, No and Not this one.
5. **Learn and re-match.** The answer turns the edge explicit (or drops it) and becomes a taste fact, so her GM doesn't ask again. Then the matcher re-runs and the Deal Sheet goes out.

The code limits come from the PRD: 20 inquiries an hour per GM, 5 a day per user, a 24-hour window, 3 counter rounds, and structured fields only, with no free text. A GM that's unsure asks its own user instead of guessing.

### Brokering: "you could make this happen if you had Kobe 11s"

The weekly drop already searches every cycle in a Circle. It can also record **near-loops**: cycles that would close if 1 more Item existed. Each near-loop is a demand signal. "3 people in your Circle want Kobe 11s" (counts only, no names) goes to people likely to own them, and the GM can say "If you have Kobe 11s, there's a 3-way waiting." This turns the network's unmet wants into a reason to add supply, which the PRD names as the market's real constraint.

To build it:
- A `demand_signals` table, per Circle, holding want embeddings and counts. The drop job rebuilds it.
- A Prospector pass that writes near-loops.
- A GM tool `get_demand` (read-only, counts only).
- A Next up kind and an eval suite that checks no names or limits leak.

### Bundles: X Items for Y, in Loops of any size up to 4

Decided Oct 7: a trade can be any number of Items for any number of Items, as long as every person approves. Both dimensions matter. **Quantity** is how many Items each person gives and gets: 2 Switch games for 1 LEGO set, or a jacket and a cap for a console. **Ring size** is how many people trade: 2 to 4 (the matcher's `max_length`, a setting). Bundles must work at every ring size: in a 3-way, Ana can give a jacket and a cap to Ben, Ben a console to Cy, and Cy a lamp to Ana.

**Why the matcher can't do it today.** Its nodes are (person, Ask). Each edge is 1 Item that fills 1 Ask, `_best_edges` keeps only the best Item for each pair, and `stage_deal` checks that every person gives 1 and gets 1. The Deal Sheet API has a single `you_give` and `you_get`. The iOS Deal Sheet already takes lists.

**Matcher v2:**
1. A leg carries a set of Items: the primary Item that fills the receiver's Ask, plus extras from the giver's offer set for that Ask.
2. Extras come in only when they help. When cash within everyone's ceilings can't bring a person within tolerance (15% or $10), the matcher may add Items. CP-SAT picks Items and cash together, adding as few Items and as little cash as it can.
3. The receiver must want every Item they get. An extra matches their Ask, their taste facts settle it, or the Liaison asks them first. Nobody is sent something they didn't ask for, and everyone still approves the Deal Sheet.
4. Asks that want several things ("2 or 3 board games", "any Switch games") are marked `accepts_many`, so several Items can fill 1 Ask.
5. Fairness is per person: the value they give plus cash paid, against the value they get plus cash received, within the same tolerance. The Deal Sheet's value line shows totals.
6. Selection treats every Item and every Ask as a conflict key, so no Item is ever in 2 Deals.

**Data and API:** a new migration replaces `stage_deal` so a person can give and get several Items, and reserves every Item in the Deal. The Deal Sheet API returns `you_give` and `you_get` as lists. The Ask page's offer check stops saying "1 Item each way".

**Tests:** matcher property tests (no Item twice, everyone within tolerance and ceilings, rings of 2 to 4, receivers want what they get), SQL tests for multi-Item staging, and review evals for bundle "whys".

### Counters in natural language

Decided Oct 7: you counter by talking to your GM, the way you'd talk to a broker. "That's a pretty good offer. Can we get a little more out of it, like a vintage Nike thing?"

1. **The GM turns your words into a structured counter:** add an Item ("something vintage Nike"), remove 1, swap 1, or change the cash. It finds candidates in the other person's offer set, such as their vintage Nike Items, and shows the counter as a card: "Ask Maya to add her '90s Nike windbreaker?" with Send and Cancel.
2. **You confirm.** The GM never sends a counter on its own (`stage_counter` stages it, and only the app sends it).
3. **The counter goes to the other person's GM** as a structured message with no free text. That GM answers from what it knows when it can: the Item is marked "would trade" and the value still balances. Otherwise it asks its user with 1 tap in Next up.
4. **The matcher re-balances** the whole Loop. A counter that changes 1 leg of a 3 or 4-way changes the Deal, so everyone approves the new Deal Sheet version.
5. **Limits:** 3 counter rounds per Deal, a 24-hour window, and no field that can carry anyone's floor or cash ceiling. The GM can't accept a counter for you.

Counters need bundles, since "add a little more" means a second Item, so they come after matcher v2.

### Multi-way and autonomy

Multi-way trades already run end to end in the matcher, from staging to Deal Sheets. Autonomy today only filters what you're shown: "Bring me every deal" or "Only likely yeses", set once on your profile (#40). Nothing ever executes without every person's approval in the app. That's a PRD rule, and Terms must say the GM proposes and only the user approves.

## Negotiating for real (Oct 7, from dogfooding)

Jackson's GM was asked "can we get a little more? Ask Anto to throw in their LEGO set", then "ask for $20 more cash instead". Both dead-ended:

- **The GM couldn't see the LEGO set.** It only saw other people's Items once they were showcase, while Deals now go out at identified. Fixed: the GM sees Circle-mates' Items once they're identified, the same bar a Deal uses. The API's counter plan already took any tradeable Item on the other person's Shelf, not only their offer for that Ask; Logged Items stay hidden, since nobody can price them yet.
- **Counters can't move cash.** The matcher sets the Throw-In to the least cash that's fair, so "a little more cash" isn't something a counter can say, though the PRD lists "a different Throw-In" as a counter. To build: a counter that asks for "a bit more", which re-balances with the cash at the edge of the fair range (15% or $10) in the asker's favor, never over the payer's private ceiling. The payer still approves, and the GM never says what the ceiling is.

## Finding what you didn't know you wanted (Oct 7, from dogfooding)

Sean: "Somebody might want to trade Gucci shoes for a PS5... the thing about agents and trading is that it makes things I might not know I want work." The rules, from first principles:

| Question | Rule | Why |
| --- | --- | --- |
| Can any Item trade for any other? | Yes, always. What you give is never limited by category: Gucci shoes for a PS5 works when the PS5's owner wants the shoes. | Value balance (ranges and Throw-Ins) is the only hard constraint on what changes hands. |
| Does an Item fill an Ask it doesn't resemble? | No, not as a want. An Ask for a PS5 isn't filled by sneakers just because they're worth the same. The check compares kinds of thing (video games, toys, sneakers...), not spellings (#56). | An Ask is your words. Filling it with something else is a guess, so it has to be asked about. |
| Where does the agent's unlock come from? | Guesses grounded in you: taste facts, what you approved, what you passed on. Today guesses must share the Ask's kind (a PS5 for an Xbox Ask). Next, guesses come from anywhere your taste points, each with the fact behind it, and the Liaison always asks first: "You said you collect vintage Nike. Would Maya's '94 windbreaker work for your Switch games?" | That's the trade a person wouldn't think to search for, and it's where a GM beats a marketplace. Asking first keeps it a suggestion, never a surprise. |
| What if I don't know what I want? | An "Open to offers" Ask: "Anything good for my Zelda." The GM brings the best guesses from your taste, ranked, each with its reason. | People know what they'd give up long before they know what they'd want back. |
| When the Circle changes, does the GM change my Asks? | Never. It looks again (a new friend, a new Shelf Item) and may suggest a tweak: "Your offer is a long shot; adding $20 or your Crocs would close it." Only you change an Ask. | Matching only proposes Deal Sheets you still approve, so looking again is free; editing your intent is yours. |

To build next, in order: taste-fact embeddings as candidate queries (PRD "From candidate to Deal Sheet", step 1, which today only embeds Ask text); a Haiku judge that keeps a cross-kind guess only when it can cite the person's own fact; "Open to offers" Asks; and re-matching when someone joins a Circle or adds to a Shelf (a trigger migration is written and waiting on Sean's OK).

## Guardrails

**Built (#41):**
- A shared prohibited list with reason codes: person, live animal, weapon, drugs, alcohol, tobacco, adult, hazardous, counterfeit, recalled, personal data.
- The Appraiser enforces it in layers: detection reports these by reason only, identification flags them, a narrow word list catches the rest, and re-reads that reveal one take the Item off the Shelf.
- The GM's resolver flags prohibited wants. Code then refuses to make an Ask from them, even if the model tries.
- Plain answers: "Pets can't be traded. Snap the things you'd trade."

**Next (Milestone 5):**
- **An independent Safety screener.** A separate model call with a narrow rubric judges every new Item and Ask, decoupled from the agent that made it, Instinct-style. It can block an Item, and it records why.
- **Recall checks** against CPSC recall data, which matter most for kids' gear.
- **Report and block** flows. The tables exist; the API and UI don't.
- **The activity log**, built from `agent_events`: every agent action with its reason, so a user can see and contest anything the GM did.

**Rules that hold now:**
- No tool shares contact details or schedules anything.
- Liaison messages will have no free text.
- Other people's words are fenced as data.
- Writes accept only server-issued IDs.

## Spend caps

Decided Oct 7: no scheduled eval runs for now, and a hard cap on anything that spends on models without a person in the loop, so a bug can't run up a bill. Defaults: $5 a day for the background agents (jobs wait in the queue past it), $3 a day per person and $10 a day in total for GM chat, and $2 per eval run. All 4 are settings; see `docs/setup.md`, "Spend caps" (#45).

## What changed in this pass

| PR | What |
| --- | --- |
| #40 | Camera crash (missing microphone permission). Chat jumps to the reply on every action. The capture sheet closes on "Add to Shelf" and progress lives on the Shelf. The scan only plays while the GM reads a photo. The Ask page is rebuilt around "will this offer land" (1 Item each way plus cash) with a GM pick. Autonomy moves to Settings. The product page is 1 page with a carousel and the GM's next step. The pick card has no empty circles. The GM knows exactly which Items you just added. |
| #41 | Guardrails: babies, pets, weapons and the rest never become Items or Asks. |
| #42 | Home "Next up". Deals waiting on others say who they wait on. |
| #43 | Several GM conversations with a drawer. |
| #45 | Spend caps on the background agents, GM chat and eval runs. Sean's decisions recorded here and in the PRD. |

## Decisions

Decided by Sean on Oct 7, 2026:

1. **Bundles: yes.** X Items for Y, in Loops of 2 to 4, as long as every person approves. See "Bundles" above.
2. **Counters: in natural language, through the GM.** See "Counters in natural language" above.
3. **Inferred edges: as recommended.** Same top-level category only, ask a person only when their taste facts don't settle it, and at most 1 inquiry per Ask per day.
4. **Demand counts: yes.** "3 people in your Circle want X", counts only, within a Circle.
5. **Evals: no scheduled runs for now, and spend caps on everything.** See "Spend caps" above.

Still open:

6. **A staging Supabase project** (cost) for the load tests and the review account.
7. **Merging.** Auto mode won't merge PRs without your OK. Merge them yourself, tell me "merge it" each time, or add a permission rule.
8. **The Apple Developer account** blocks Sign in with Apple, passkeys, App Attest, push and TestFlight.

## What's left in the PRD

| Milestone | Not built yet |
| --- | --- |
| 0 Foundations | Sign in with Apple and passkeys (dev email sign-in today); App Attest verification; the staging project |
| 1 Shelf and appraisal | A 100-Item hand-labeled appraisal set (26 cases with #41) and measuring the "Done when"; an offline SwiftData cache |
| 2 GM and Asks | Real-model runs of `eval:gm`; a prompt cache hit-rate gate |
| 3 Matching and Deal Sheets | Bundles (X for Y); counters in natural language; the Liaison and its protocol; inferred edges; demand counts; "someone wants your item"; real-model runs of `eval:review` |
| 4 Handoffs and Throw-Ins | Everything: the handoff coordinator, Stripe Connect and Apple Pay, ratings, adding received Items to the Shelf, push with action buttons and the daily cap |
| 5 Safety and launch | The independent Safety screener, recall checks, report and block, the activity log screen, eval gates in CI with dashboards and alerts, TestFlight and the review account |
| 6 Pilot | All of it |

### Suggested order

1. **Spend caps** (#45).
2. **Bundles in the matcher**, then multi-Item staging, Deal Sheets and the Ask page.
3. **Counters in natural language**, which build on bundles.
4. **The Liaison with inferred edges, "someone wants your item" and demand counts** (finishes Milestone 3).
5. **The Safety screener and the activity log** (Milestone 5 items that make delegation trustworthy).
6. **Milestone 4.** It starts once the Apple Developer account exists, since push and Apple Pay need it.
