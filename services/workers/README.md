# @throwin/workers

Background agents. Milestone 1 ships the Appraiser: it claims `appraise_capture` and `reappraise_item` jobs from the Postgres queue (`claim_job`), turns a capture's photos or frames into priced Items, and writes `agent_runs` for every model call.

Pipeline (`src/appraiser/pipeline.ts`): prepare frames (EXIF rotate; up to 2048 px kept for cutting crops, 1000 px for Claude) → detect objects across frames with Haiku, on frames with a light labeled coordinate grid (the detector merges repeat sightings) → drop private things (medication, hygiene items, medical and mobility aids, documents, fixtures; `privacy.ts` backs up the prompts) → for each object, cut 2 wide context close-ups around its best appearances (at least 35% of the box and 20% of the frame of padding a side, at least 30% of the frame) → identify and grade with Sonnet, which also returns a tight `box_in_crop` per close-up → map those boxes back to the frame (the detector's box is the fallback when one is missing or degenerate) and cut the hero crop from the full-size frame with the largest refined box times frame sharpness → 1 Haiku consolidation call per capture over a numbered contact sheet of every candidate (title, frames, crop) folds double counts and parts of 1 thing → save every Item right away with `appraising = true` and its `item_media.crop_box` → price each in place (shared `price_cache` first, then Haiku research with web search, Sonnet as a fallback when Haiku's estimate is weak, and a Haiku extraction to a range) and write its Voyage embedding. The capture is `done` only when every Item is finished. Both confidences at or above 0.7 go to `on_shelf`; otherwise `needs_photos` with a specific follow-up photo request.

Follow-up photos (`reappraise_item`): re-reads the Item from its hero image plus the newest batch of photos, re-prices only when the product, variant or grade changed (or it had no value), promotes a larger, sharper photo to the hero image (re-encoded, EXIF stripped), and updates the Item in place.

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
| `ANTHROPIC_MAX_RETRIES` | 4 | SDK retries on 429 and 5xx, with backoff. |

Run locally: `pnpm --filter @throwin/workers dev`.
