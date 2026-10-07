# Agents, background work and agent-to-agent trading

Oct 6, 2026. What Throw-In's agents do when you're not looking, how 2 GMs will trade on their users' behalf, how we keep it safe, and what's left to build. Product behavior defers to `docs/prd.md`; this spec fills in what the PRD leaves open and records decisions that need Sean.

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
| Tell you when someone wants your Item | Prospector → Liaison | Another Ask matches your Item | "Maya is looking for a Switch game you have" | Not built (M3) |
| Ask the other GM when a trade rests on a guess | Liaison | A Loop needs an inferred edge | "Would a PS5 work instead of an Xbox?" | Not built (M3) |
| Spot trades 1 Item away (brokering) | Prospector (drop) | Weekly | "You could make a 3-way happen with Kobe 11s" | Proposed |
| Keep values fresh | Refiner | Weekly, for Items in active offers | Ranges move; the Ask page fit updates | Proposed |
| Nudge on what's stuck | Notifier | Approval waiting 12 hours, quiet Ask for a week | Push with actions | Not built (M4) |
| Arrange the handoff | Handoff coordinator | Every person approved | 2 or 3 times and places, reminders | Not built (M4) |
| Screen every new Item | Safety screener | Item created | Blocked with a reason | In the Appraiser and GM (#41); the independent screener is M5 |

## Agent-to-agent trading

### Is it built?

Partly. The matcher already finds 2 to 4-person Loops among people's **explicit** wants, balances them with cash Throw-Ins and never promises an Item twice (Milestone 3). What isn't built is everything that needs 2 GMs to talk: the **Liaison**, **inferred edges**, **counters** and **demand signals**. All 4 are Milestone 3 work in the PRD.

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

### Multi-way and autonomy

Multi-way trades already run end to end in the matcher, from staging to Deal Sheets. Autonomy today only filters what you're shown: "Bring me every deal" or "Only likely yeses", set once on your profile (#40). Nothing ever executes without every person's approval in the app. That's a PRD rule, and Terms must say the GM proposes and only the user approves.

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

## What changed in this pass

| PR | What |
| --- | --- |
| #40 | Camera crash (missing microphone permission). Chat jumps to the reply on every action. The capture sheet closes on "Add to Shelf" and progress lives on the Shelf. The scan only plays while the GM reads a photo. The Ask page is rebuilt around "will this offer land" (1 Item each way plus cash) with a GM pick. Autonomy moves to Settings. The product page is 1 page with a carousel and the GM's next step. The pick card has no empty circles. The GM knows exactly which Items you just added. |
| #41 | Guardrails: babies, pets, weapons and the rest never become Items or Asks. |
| #42 | Home "Next up". Deals waiting on others say who they wait on. |
| #43 | Several GM conversations with a drawer. |

## Decisions for Sean

1. **Bundles.** Today every trade swaps 1 Item each way plus cash, and the Ask page now says so. Allowing 2 Items for 1 makes small things useful, but it complicates matching and fairness. My recommendation: not in v1; measure in the pilot how often offers fall short only for lack of bundling.
2. **Counters** (raised before). My proposal: a counter is "change my terms": a lower cash ceiling, or taking an Item out of the offer. Then re-match right away, at most 3 counters per Deal.
3. **How eager inferred edges should be.** My recommendation: same top-level category only, ask a person only when their taste facts don't settle it, and at most 1 inquiry per Ask per day.
4. **A demand board.** Show "3 people in your Circle want X", as counts only? It drives supply, but it reveals Circle-level wants. My recommendation: counts only, within a Circle.
5. **Real-model evals in CI.** My recommendation: nightly runs of the GM, review, safety and appraisal suites with a CI key, not on every PR. This costs model spend.
6. **A staging Supabase project** (cost) for the load tests and the review account.
7. **Merging.** Auto mode won't merge PRs without your OK. Merge them yourself, tell me "merge it" each time, or add a permission rule.
8. **The Apple Developer account** blocks Sign in with Apple, passkeys, App Attest, push and TestFlight.

## What's left in the PRD

| Milestone | Not built yet |
| --- | --- |
| 0 Foundations | Sign in with Apple and passkeys (dev email sign-in today); App Attest verification; the staging project |
| 1 Shelf and appraisal | A 100-Item hand-labeled appraisal set (26 cases with #41) and measuring the "Done when"; an offline SwiftData cache |
| 2 GM and Asks | Real-model runs of `eval:gm`; a prompt cache hit-rate gate |
| 3 Matching and Deal Sheets | The Liaison and its protocol; inferred edges; counters; "someone wants your item"; real-model runs of `eval:review` |
| 4 Handoffs and Throw-Ins | Everything: the handoff coordinator, Stripe Connect and Apple Pay, ratings, adding received Items to the Shelf, push with action buttons and the daily cap |
| 5 Safety and launch | The independent Safety screener, recall checks, report and block, the activity log screen, eval gates in CI with dashboards and alerts, TestFlight and the review account |
| 6 Pilot | All of it |

### Suggested order

1. **Merge and deploy #40 to #43, then test on device.**
2. **The Liaison with inferred edges and "someone wants your item"** (finishes Milestone 3). This is the biggest step toward the Mary-and-the-PS5 trade.
3. **Counters** (also Milestone 3).
4. **The Safety screener and the activity log** (Milestone 5 items that make delegation trustworthy).
5. **Milestone 4.** It starts once the Apple Developer account exists, since push and Apple Pay need it.
