import { type GmComponentKind, type GmMode, IdAllowList } from "@throwin/shared";
import type { StoredMessage } from "./data.js";
import { type ResolvedTargetData, rowMeta, toolCallsOf } from "./history.js";

export interface KnownComponent {
  kind: GmComponentKind;
  optionIds: string[];
}

/**
 * Per-conversation state the tools enforce. It is rebuilt from stored rows at the start of
 * every turn, so it survives restarts and never trusts anything the model wrote itself:
 * - `allow`: every ID the server returned to this conversation (tool results, the Shelf
 *   and Ask summaries, the user's own uploads).
 * - `targets`: products `resolve_target` found, by the target ID it issued.
 * - `components`: rendered cards, so a posted choice can be checked.
 * - `amounts`: whole-dollar amounts tool results showed, for the grounding check.
 */
export class GmSession {
  readonly allow = new IdAllowList();
  readonly targets = new Map<string, ResolvedTargetData>();
  readonly components = new Map<string, KnownComponent>();
  readonly amounts = new Set<number>();
  recapShown = false;
  mode: GmMode;

  constructor(
    readonly userId: string,
    readonly conversationId: string,
    mode: GmMode,
  ) {
    this.mode = mode;
  }

  /** Replays stored rows: their issued IDs, targets, cards and amounts. */
  absorb(rows: StoredMessage[]) {
    for (const row of rows) {
      const meta = rowMeta(row);
      if (meta?.kind === "user_input" && meta.media_paths) this.allow.remember(meta.media_paths);
      for (const call of toolCallsOf(row)) {
        if (!call.ok) continue;
        if (call.issued_ids) this.allow.remember(call.issued_ids);
        if (call.target) {
          this.allow.remember(call.target.target_id);
          this.targets.set(call.target.target_id, call.target.data);
        }
        if (call.component) {
          this.components.set(call.component.id, {
            kind: call.component.kind,
            optionIds: call.component.option_ids ?? [],
          });
          if (call.component.kind === "recap") this.recapShown = true;
        }
        for (const a of call.amounts ?? []) this.amounts.add(a);
        if (call.name === "finish_intake") this.mode = "chat";
      }
    }
  }
}
