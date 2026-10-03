import type { TasteFactCategory, TasteFactSource } from "@throwin/shared";
import { z } from "zod";
import type { ModelRun } from "../appraiser/claude.js";
import type { Logger } from "../log.js";
import type { MemoryModel } from "./model.js";
import { type StoredMessage, turnLines } from "./text.js";
import {
  type ExistingFact,
  type Rejection,
  type ValidWrite,
  validateOperations,
} from "./validator.js";

/** The extract_memory job the harness enqueues after each finished GM turn. */
export const ExtractMemoryPayload = z.object({
  user_id: z.uuid(),
  conversation_id: z.uuid(),
  message_ids: z.array(z.uuid()).min(1).max(20),
  /** Optional: the conversation's mode when the turn ran. Read from the conversation if absent. */
  mode: z.enum(["intake", "chat"]).optional(),
});
export type ExtractMemoryPayload = z.infer<typeof ExtractMemoryPayload>;

export const MEMORY_AGENT = "memory.extract";

export interface NewFact {
  key: string;
  value: string;
  category: TasteFactCategory;
  alwaysOn: boolean;
  source: TasteFactSource;
  sourceSessionId: string;
  confidence: number;
}

export interface MemoryEvent {
  runId: string;
  userId: string;
  type: "memory.write" | "memory.rejected";
  userVisible: boolean;
  summary: string | null;
  payload: Record<string, unknown>;
}

/** Database access for the extractor. Every method is scoped by the user. */
export interface MemoryStore {
  /** Only this user's messages in this conversation, whatever IDs the job names. */
  loadMessages(
    userId: string,
    conversationId: string,
    messageIds: string[],
  ): Promise<StoredMessage[]>;
  /** The conversation's mode, or null when unknown. */
  conversationMode(userId: string, conversationId: string): Promise<"intake" | "chat" | null>;
  /** The user's facts in every status (deleted ones are never written again). */
  loadFacts(userId: string): Promise<ExistingFact[]>;
  /** First names of the other people in the user's Circles. */
  otherNames(userId: string): Promise<string[]>;
  /** Writes an agent_runs row and returns its ID. */
  insertRun(userId: string, run: ModelRun, trigger: string): Promise<string>;
  /** The new fact's ID, or null when the database refused it (duplicate or over the cap). */
  createFact(userId: string, fact: NewFact): Promise<string | null>;
  /** Moves an active fact to another status. False when it was no longer active. */
  setFactStatus(
    userId: string,
    factId: string,
    from: ExistingFact["status"],
    to: ExistingFact["status"],
  ): Promise<boolean>;
  recordEvent(event: MemoryEvent): Promise<void>;
}

export interface MemoryDeps {
  store: MemoryStore;
  /** Builds the model with a callback for each model run, so runs land in agent_runs. */
  createModel: (onRun: (run: ModelRun) => void) => MemoryModel;
  logger: Logger;
}

export interface ExtractOutcome {
  status: "ok" | "no_text";
  written: number;
  rejected: Rejection[];
}

/** Facts from what the user said are fairly sure; the model only hears 1 turn. */
const CONFIDENCE = 0.8;

/**
 * Reads 1 turn's user and GM text, asks the model what to remember, and applies only what
 * the write validator accepts. Each write leaves a user-visible agent_events row.
 */
export async function extractMemory(
  payload: ExtractMemoryPayload,
  deps: MemoryDeps,
): Promise<ExtractOutcome> {
  const { store, logger } = deps;
  const userId = payload.user_id;
  const messages = await store.loadMessages(userId, payload.conversation_id, payload.message_ids);
  const turn = turnLines(messages);
  if (!turn.some((l) => l.role === "user")) {
    return { status: "no_text", written: 0, rejected: [] };
  }

  const [facts, otherNames, storedMode] = await Promise.all([
    store.loadFacts(userId),
    store.otherNames(userId),
    payload.mode
      ? Promise.resolve(payload.mode)
      : store.conversationMode(userId, payload.conversation_id),
  ]);
  const source: TasteFactSource = storedMode === "intake" ? "intake" : "chat";
  // Server-issued refs: the model can only name facts shown to it, by ref, never by ID.
  const shown = facts
    .filter((f) => f.status === "active")
    .map((fact, i) => ({ ref: `f${i + 1}`, fact }));
  const refs = new Map(shown.map((s) => [s.ref, s.fact]));

  const runs: ModelRun[] = [];
  let runId: string | null = null;
  const saveRuns = async () => {
    for (const run of runs.splice(0)) {
      runId = await store.insertRun(userId, run, "extract_memory");
    }
  };
  let proposal: Awaited<ReturnType<MemoryModel["propose"]>>;
  try {
    proposal = await deps.createModel((run) => runs.push(run)).propose({ facts: shown, turn });
  } finally {
    await saveRuns();
  }
  if (!runId) throw new Error("memory.extract: the model run was not recorded");
  const run: string = runId;

  const { writes, rejections } = validateOperations(proposal.operations, {
    facts,
    refs,
    otherNames,
  });

  let written = 0;
  for (const write of writes) {
    const factId = await apply(store, userId, write, source, payload.conversation_id);
    if (!factId) {
      rejections.push({
        op: write.op,
        key: write.op === "delete" ? write.fact.key : write.key,
        reason: "duplicate",
      });
      continue;
    }
    written++;
    await store.recordEvent({
      runId: run,
      userId,
      type: "memory.write",
      userVisible: true,
      summary: write.summary,
      payload: {
        op: write.op,
        fact_id: factId,
        conversation_id: payload.conversation_id,
        ...(write.op === "delete"
          ? { key: write.fact.key }
          : {
              key: write.key,
              value: write.value,
              category: write.category,
              always_on: write.alwaysOn,
              ...(write.op === "update" && { replaced_fact_id: write.fact.id }),
            }),
      },
    });
  }
  for (const r of rejections) {
    // Internal only, and never the value: a rejected value may be the sensitive part.
    await store.recordEvent({
      runId: run,
      userId,
      type: "memory.rejected",
      userVisible: false,
      summary: null,
      payload: { op: r.op, key: r.key, reason: r.reason, ...(r.detail && { detail: r.detail }) },
    });
  }
  logger.info("memory_extracted", {
    user_id: userId,
    conversation_id: payload.conversation_id,
    proposed: proposal.operations.length,
    written,
    rejected: rejections.map((r) => r.reason),
  });
  return { status: "ok", written, rejected: rejections };
}

/** Applies 1 validated write. Returns the fact ID it wrote or retired, or null if refused. */
async function apply(
  store: MemoryStore,
  userId: string,
  write: ValidWrite,
  source: TasteFactSource,
  conversationId: string,
): Promise<string | null> {
  if (write.op === "delete") {
    // The user took it back in chat: superseded, not deleted, so saying it again later
    // can store it again. Only the Settings delete is permanent.
    const done = await store.setFactStatus(userId, write.fact.id, "active", "superseded");
    return done ? write.fact.id : null;
  }
  const fact: NewFact = {
    key: write.key,
    value: write.value,
    category: write.category,
    alwaysOn: write.alwaysOn,
    source,
    sourceSessionId: conversationId,
    confidence: CONFIDENCE,
  };
  if (write.op === "create") return store.createFact(userId, fact);
  // Update: retire the old row first (it may share the key and value), then write the new
  // one; if the new one is refused, put the old one back.
  if (!(await store.setFactStatus(userId, write.fact.id, "active", "superseded"))) return null;
  const id = await store.createFact(userId, fact);
  if (!id) await store.setFactStatus(userId, write.fact.id, "superseded", "active");
  return id;
}
