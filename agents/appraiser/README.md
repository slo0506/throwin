# Appraiser

Prompts and structured-output schemas for detection (Haiku), identification and grading (Sonnet), and pricing. Built in Milestone 1. Output shape is in `docs/prd.md` under "Appraisal output".

The prompts live with the code: `services/workers/src/appraiser/prompts.ts` (`PROMPT_VERSION`) and, for the Refiner (photo scores, Tune up questions, SKU research and folding in answers), `services/workers/src/refiner/prompts.ts` (`REFINER_PROMPT_VERSION`). Bump the version with every prompt change and add cases to `evals/cases/appraisal/` or `evals/cases/refiner/` (suite `refinement`).

## What can't be traded

Throw-In's prohibited list lives in `packages/shared/src/safety.ts` as reason codes (`person`, `live_animal`, `weapon`, `drugs`, `alcohol`, `tobacco`, `adult`, `hazardous`, `counterfeit`, `recalled`, `personal_data`), shared with the GM's target resolver. Enforcement is layered:

1. **Detection** never reports these as objects; it lists them in `not_tradeable` by reason only (no label, so a person or a private thing is never described).
2. **Identification** sets `prohibited_reason` when a close-up shows the item is one.
3. **A word backstop** (`prohibitedByWords`) catches model-written labels and titles that can only mean a prohibited thing, kept narrow so toys and props stay tradeable.
4. **Re-reads:** new photos that show an Item is prohibited take it off the Shelf.

The capture's summary says what happened in plain words: "Pets can't be traded. Snap the things you'd trade." instead of "Try closer", and "Left out 1 thing Throw-In can't trade" when the rest landed. People and pets in the background of a shelf photo are never mentioned. The PRD's separate Safety screener (Milestone 5) adds an independent check on every new Item behind these.
