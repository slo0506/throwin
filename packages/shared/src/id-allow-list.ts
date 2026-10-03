export class UnknownIdError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`ID was not issued to this session: ${id}`);
    this.name = "UnknownIdError";
    this.id = id;
  }
}

/**
 * Per-session set of IDs the server has returned to the model. Write and render tools
 * call `assert` so the model can only act on IDs it was actually shown.
 */
export class IdAllowList {
  readonly #ids = new Set<string>();

  remember(ids: Iterable<string> | string): void {
    if (typeof ids === "string") {
      this.#ids.add(ids);
      return;
    }
    for (const id of ids) this.#ids.add(id);
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  assert(id: string): void {
    if (!this.#ids.has(id)) throw new UnknownIdError(id);
  }

  get size(): number {
    return this.#ids.size;
  }
}
