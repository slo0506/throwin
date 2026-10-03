# Appraiser

Prompts and structured-output schemas for detection (Haiku), identification and grading (Sonnet), and pricing. Built in Milestone 1. Output shape is in `docs/prd.md` under "Appraisal output".

The prompts live with the code: `services/workers/src/appraiser/prompts.ts` (`PROMPT_VERSION`) and, for the Refiner (photo scores, Tune up questions, SKU research and folding in answers), `services/workers/src/refiner/prompts.ts` (`REFINER_PROMPT_VERSION`). Bump the version with every prompt change and add cases to `evals/cases/appraisal/` or `evals/cases/refiner/` (suite `refinement`).
