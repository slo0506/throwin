# Trust and verification

Oct 7, 2026, after the first 2-phone dogfood on prod. How Throw-In makes lying expensive and honesty cheap, and what changes in the product. Product behavior defers to `docs/prd.md`; this spec records the decisions and the plan.

## What dogfooding showed

- A showcase set made of a stock photo of a different Insta360 X3, a lens cap from an Insta360 X4, and the stock photo again scored 92. The grader assumed every extra photo showed the same item and only checked angles and light.
- Anyone can photograph an iPhone at an Apple Store, or download one, and list it.
- Requiring 4 perfect showcase angles before a Deal Sheet could go out stalled every Deal, while stock photos could still pass it. It taxed honest people and barely slowed dishonest ones.

## What's actually at risk

Money moves only after both people confirm the handoff in person (PRD "Handoff and after": Throw-Ins are captured at confirmation). So the worst remote outcome is a wasted trip, not a stolen payment. The risks, in order of how often they'll happen:

| Risk | Example | Harm | Caught today | Add |
| --- | --- | --- | --- | --- |
| Misrepresented condition | Scuffs hidden, stock photo instead of the real unit | You receive worse than promised | Inspection at handoff (M4) | Same-item photo checks (now), live photo before the handoff (pilot) |
| Phantom item | Stock or store photos of something they don't own | Wasted trip, broken trust | Nothing before the meetup | Live photo before the handoff, no-show reputation (pilot) |
| Counterfeit | Replica sneakers, fake LEGO | You get a fake | Nothing | Category proof angles, "can't tell from photos" flags, handoff check (pilot), authentication (later) |
| Swap at handoff | Shows 1 unit, hands over another | Wrong item | Inspection | Handoff scan against the listing photos and serial (pilot) |
| Fake accounts | Farming ratings, sock puppets | Misplaced trust | Circles are invite-only, App Attest | Reputation weighted by Circle overlap (pilot) |
| Stolen goods | Resale of stolen electronics | Legal and moral | Nothing | Private serial capture and registry checks (later) |

## Principles

1. **Evidence beats polish.** 1 live photo of your unit, taken in the app, says more than 4 studio-perfect angles from anywhere.
2. **Ask for proof when someone's about to commit, not before they've seen the trade.** Deal Sheets go out early. Proof is required before anyone travels.
3. **The handoff is the ground truth.** The receiver checks the item with the app and can walk away with no penalty.
4. **Reputation compounds inside Circles.** Real friends, real names, a record of trades that went as described.
5. **Show the evidence, never hide it.** Every Item on a Deal Sheet says how it was shown: live photos, photos from a library, or not checked yet.
6. **Honest people pay almost nothing.** 1 live photo per Deal, not identity checks.
7. **The GM is your advocate.** It says when something looks off, in plain words, and never vouches for more than the evidence shows. It never says "fake", only what the photos can and can't show.

## Decisions (Oct 7)

- **Deal Sheets go out once the GM knows what every Item is, not at showcase** (Option A). Showcase stays as homework that makes an offer stronger. A Deal waits only while an Item's identity is unknown (not confirmed and under 0.85 confidence), and its owner gets the cheapest way to pin it down: quick answers, then photos (`pin_down_item`, `showcase_photos` in Next up). A wide value range never holds a Deal: both people see the ranges. Migrations `20261023000100_deals_at_identified.sql` and `20261023000400_deal_gate_is_identity.sql`; answers and photos for a held Item in `20261022000100` and `20261023000300`.
- **A photo only counts when it shows the same item.** The Refiner checks every photo against the Item's first photo: same unit, a different object, or unclear; whether it looks like a stock or store photo; and exact repeats. Photos that fail don't count toward the score or the angles, and the owner sees why ("This one doesn't look like your Insta360 X3, so it isn't counted").

## Plan

### Now (shipped with this spec)

- Same-item, stock-photo and duplicate checks in the Refiner's photo grading. New photo issues: `wrong_item`, `stock_photo`, `duplicate_photo`.
- Deals at identified.

### Before handoffs ship (Milestone 4, first)

- **Photo provenance.** Every `item_media` row records how it was taken: `camera` (the in-app camera, live), `library` (camera roll) or `capture` (the first capture). Only `camera` photos earn the "Live photo" mark. Simulator builds have no camera, so they can never earn it.
- **Live check before the handoff.** Once everyone approves, each giver takes 1 live photo of their Item in the app (camera only, a server-issued nonce, App Attest). The GM compares it with the listing: same unit, same condition. The Deal moves to scheduling only when every Item passes. Nobody travels for a phantom item.
- **Handoff check.** At the meetup the receiver scans the Item. The GM compares it with the live photo and, for electronics, reads the serial with Vision. A mismatch means walk away, no penalty for the honest person, and a flag on the other.
- **Reputation.** Trades completed, the share that went as described, and no-shows, on every Deal Sheet participant: "12 trades, all as described, in 2 of your Circles". A trust ladder: until someone has 3 completed trades, a Deal they're in tops out at $150 of value per person.
- **Counterfeit-prone categories.** Sneakers, luxury and trading cards need their proof angles (size tag, box label, card back) in live photos before the Live mark. The GM flags "can't tell from photos" instead of guessing.

### Later

- Optional proof of purchase (a receipt), which raises an Item's trust mark.
- Private serial capture with registry checks for stolen electronics.
- Third-party authentication and insurance for high-value trades.

## What people see

- **Deal Sheet, each Item:** a small mark under the photo: "Live photos" (mint), "Photos from their library" (gold), or "Not checked yet" (grey), next to the condition grade and value range.
- **Deal Sheet, each person:** trades completed, as described, shared Circles.
- **Product card and Showcase shoot:** when a photo is left out, 1 plain sentence why, and the shoot asks for it again.

## Open questions for Sean

- The trust-ladder cap ($150 per person until 3 trades) is a guess. Tune it from pilot data.
- Should close friends be able to skip the live check ("I know Jordan")? Leaning no for the pilot: it's 1 photo, and it protects both of them.
