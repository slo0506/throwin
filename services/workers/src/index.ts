/**
 * Background workers. Placeholder until Milestone 1 (Appraiser) and later milestones.
 * Jobs run on a Postgres-backed queue so v1 keeps to 1 database.
 */
export const WORKER_NAMES = [
  "appraiser",
  "prospector",
  "liaison",
  "handoff_coordinator",
  "memory_extractor",
  "safety_screener",
] as const;

export type WorkerName = (typeof WORKER_NAMES)[number];
