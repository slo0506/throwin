import { randomUUID } from "node:crypto";
import type { GmStreamEvent } from "@throwin/shared";

/** Finished streams stay replayable this long, so a client can reconnect and read `done`. */
export const STREAM_TTL_MS = 5 * 60 * 1000;

const isTerminal = (e: GmStreamEvent) => e.event === "done" || e.event === "error";

type Listener = (event: GmStreamEvent) => void;

/** 1 GM turn's events, buffered so a client that connects late still sees all of them. */
export class GmStream {
  readonly events: GmStreamEvent[] = [];
  finishedAt: number | null = null;
  readonly #listeners = new Set<Listener>();

  constructor(
    readonly id: string,
    readonly userId: string,
  ) {}

  get finished() {
    return this.finishedAt !== null;
  }

  push(event: GmStreamEvent, now: number) {
    if (this.finished) return;
    this.events.push(event);
    if (isTerminal(event)) this.finishedAt = now;
    for (const listener of this.#listeners) listener(event);
    if (this.finished) this.#listeners.clear();
  }

  /** Replays everything so far, then follows live events until the turn ends. */
  subscribe(listener: Listener): () => void {
    for (const e of this.events) listener(e);
    if (!this.finished) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/**
 * In-memory streams for 1 API instance (contract: "Streams are held in memory per API
 * instance"). Also enforces 1 running turn per user.
 */
export class GmStreamHub {
  readonly #streams = new Map<string, GmStream>();
  readonly #running = new Map<string, GmStream>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = STREAM_TTL_MS,
  ) {}

  /** A new running stream for the user, or null while another turn of theirs runs. */
  tryStart(userId: string): GmStream | null {
    this.#sweep();
    if (this.#running.has(userId)) return null;
    const stream = new GmStream(randomUUID(), userId);
    this.#streams.set(stream.id, stream);
    this.#running.set(userId, stream);
    return stream;
  }

  push(stream: GmStream, event: GmStreamEvent) {
    stream.push(event, this.now());
  }

  /** The turn is over: frees the user's slot and makes sure the stream has an ending. */
  finish(stream: GmStream) {
    if (!stream.finished) {
      this.push(stream, {
        event: "error",
        data: { code: "gm_failed", message: "Something went wrong on my side. Try that again." },
      });
    }
    if (this.#running.get(stream.userId) === stream) this.#running.delete(stream.userId);
  }

  /** The turn never started (bad input): forget the stream entirely. */
  abandon(stream: GmStream) {
    this.#streams.delete(stream.id);
    if (this.#running.get(stream.userId) === stream) this.#running.delete(stream.userId);
  }

  get(id: string): GmStream | null {
    this.#sweep();
    return this.#streams.get(id) ?? null;
  }

  isRunning(userId: string) {
    return this.#running.has(userId);
  }

  #sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, s] of this.#streams) {
      if (s.finishedAt !== null && s.finishedAt < cutoff) this.#streams.delete(id);
    }
  }
}
