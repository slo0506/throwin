# @throwin/workers

Background agents. Milestone 1 ships the Appraiser: it claims `appraise_capture` jobs from the Postgres queue (`claim_job`), turns a capture's photos or frames into priced Items, and writes `agent_runs` for every model call.

Pipeline (`src/appraiser/pipeline.ts`): prepare frames (EXIF rotate, 1000 px) → detect objects across frames with Haiku (the detector merges repeat sightings) → crop each object's 2 best appearances → identify and grade with Sonnet → price with Sonnet and web search, then extract a range with Haiku → save Item, crop, appraisal and Voyage embedding. Both confidences at or above 0.7 go to `on_shelf`; otherwise `needs_photos` with a specific follow-up photo request.

Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`. On Railway these reference the API service's variables.

Run locally: `pnpm --filter @throwin/workers dev`.
