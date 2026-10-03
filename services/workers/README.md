# @throwin/workers

Background agents. Milestone 1 ships the Appraiser and the Refiner: they claim `appraise_capture`, `reappraise_item` and `refine_item` jobs from the Postgres queue (`claim_job`), turn a capture's photos or frames into priced Items, narrow each Item toward an exact product, and write `agent_runs` for every model call.

Pipeline (`src/appraiser/pipeline.ts`): prepare frames (EXIF rotate; up to 2048 px kept for cutting crops, 1000 px for Claude) → detect objects across frames with Haiku, on frames with a light labeled coordinate grid (the detector merges repeat sightings) → drop private things (medication, hygiene items, medical and mobility aids, documents, fixtures; `privacy.ts` backs up the prompts) → for each object, cut 2 wide context close-ups around its best appearances (at least 35% of the box and 20% of the frame of padding a side, at least 30% of the frame) → identify and grade with Sonnet, which also returns a tight `box_in_crop` per close-up → map those boxes back to the frame (the detector's box is the fallback when one is missing or degenerate) and cut the hero crop from the full-size frame with the largest refined box times frame sharpness → 1 Haiku consolidation call per capture over a numbered contact sheet of every candidate (title, frames, crop) folds double counts and parts of 1 thing → save every Item right away with `appraising = true` and its `item_media.crop_box` → price each in place (shared `price_cache` first, then Haiku research with web search, Sonnet as a fallback when Haiku's estimate is weak, and a Haiku extraction to a range) and write its Voyage embedding. The capture is `done` only when every Item is finished. Every Item is saved `on_shelf` (never `needs_photos`); a low-confidence reading keeps the photo it would want in `follow_up` as a hint, and each priced Item is handed to the Refiner with a `refine_item` job.

Follow-up photos (`reappraise_item`): re-reads the Item from its hero image plus the newest batch of photos, re-prices only when the product, variant or grade changed (or it had no value), promotes a larger, sharper photo to the hero image (re-encoded, EXIF stripped), updates the Item in place, then queues a `refine_item` pass to score the new photos.

Refiner (`src/refiner/refine.ts`, `refine_item` with reason `created`, `answer` or `photos`), 1 pass per job:

1. **Answers:** Folds answered questions into the reading with 1 Haiku call (`refiner.answer`), skipping "Not sure" and skips. Re-prices through the shared price cache only when a value driver changed. A picked candidate or a confirmed model sets `identity_confirmed`.
2. **Photo score:** Resolution, Laplacian sharpness and exposure are measured in code with sharp; framing, background and which category angles any photo shows come from 1 Haiku call (`refiner.score`). Weights: resolution 20, sharpness 20, exposure 15, framing 15, background 15, coverage 15. A long edge under 600 px caps the score at 40. Skipped on `answer` passes once a score exists.
3. **Questions:** From the category value-driver table (`src/refiner/categories.ts`, the PRD table), unknown drivers that are not open, answered, skipped twice or skipped recently get at most 3 open questions, ranked by impact over effort. Sonnet SKU research with web search (`refiner.research`, 2 searches) runs only when the range is wide (high over 1.6 times low), mid is at least $40 and an identity driver is unknown, at most once a day unless the owner added information. 1 Haiku call (`refiner.questions`) writes the questions and, when missing, the description. Once the Item is identified, open questions are closed.

Readiness is computed by the `items_readiness` trigger on every write; `@throwin/shared` mirrors it as `computeReadiness`. First-pass cost without research is about half a cent per Item, under the 2 cent target: 2 Haiku calls, about 1,100 input and 100 output tokens with the hero at 768 px, and about 1,000 input and 400 output tokens of text. Research adds about 2 to 5 cents (Sonnet plus 2 searches at 1 cent each).

Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`. On Railway these reference the API service's variables.

Tuning (all optional):

| Variable | Default | What it does |
| --- | --- | --- |
| `PARALLEL_IDENTIFY` | 5 | Sonnet identify calls at once. |
| `PARALLEL_PRICING` | 10 | Items priced at once. |
| `PRICE_RESEARCH_MODEL` | `haiku` | `haiku` or `sonnet` for the research turn. |
| `PRICE_FALLBACK_MODEL` | `sonnet` | Re-research when the first estimate is weak; `none` disables it. |
| `PRICE_FALLBACK_BELOW` | 0.4 | Confidence below which the fallback runs. |
| `PRICE_MAX_SEARCHES` | 2 | `web_search` max_uses per research turn. |
| `PRICE_RESEARCH_MAX_TOKENS` | 1024 | max_tokens per research request. |
| `PRICE_CACHE_TTL_DAYS` | 7 | How long a price is reused for the same product and grade; 0 disables. |
| `PRICE_CACHE_MIN_CONFIDENCE` | 0.5 | Only estimates this confident are cached. |
| `DETECT_GRID` | `true` | Draw the coordinate grid on detection images; `false` turns it off. |
| `REFINER_MAX_OPEN_QUESTIONS` | 3 | Open questions per Item at most. |
| `REFINER_RESEARCH` | `true` | SKU research with web search; `false` turns it off. |
| `REFINER_RESEARCH_MODEL` | `sonnet` | `haiku` or `sonnet` for SKU research. |
| `REFINER_RESEARCH_MAX_SEARCHES` | 2 | `web_search` max_uses per research pass. |
| `REFINER_RESEARCH_MIN_MID_CENTS` | 4000 | Research only Items whose mid value is at least this. |
| `REFINER_RESEARCH_COOLDOWN_HOURS` | 24 | At most 1 research pass per Item in this window, unless the owner added information. |
| `REFINER_REASK_AFTER_HOURS` | 72 | A question skipped once may come back after this long; twice means never. |
| `REFINER_SHARPNESS_LOW` | 20 | Laplacian variance that scores 0 for sharpness. |
| `REFINER_SHARPNESS_HIGH` | 200 | Laplacian variance that scores full marks for sharpness. |
| `ANTHROPIC_MAX_RETRIES` | 4 | SDK retries on 429 and 5xx, with backoff. |

Run locally: `pnpm --filter @throwin/workers dev`.
