import { TasteFactCategory } from "@throwin/shared";
import { z } from "zod";
import { strict } from "../appraiser/schemas.js";

/** At most this many operations from 1 turn. Anything past it is dropped. */
export const MAX_OPERATIONS = 8;

export const MemoryOperation = z.object({
  op: z.enum(["create", "update", "delete"]),
  /** A current fact's ref (f1, f2, ...) for update and delete. Null for create. */
  ref: z.string().nullable(),
  key: z.string(),
  value: z.string(),
  category: TasteFactCategory,
  always_on: z.boolean(),
  about: z.enum(["user", "other_person"]),
  evidence: z.enum(["user_said", "assistant_only"]),
  note: z.string(),
});
export type MemoryOperation = z.infer<typeof MemoryOperation>;

export const MemoryProposal = z.object({
  operations: z.array(MemoryOperation).transform((ops) => ops.slice(0, MAX_OPERATIONS)),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

export const memoryProposalJsonSchema = strict({
  type: "object",
  properties: {
    operations: {
      type: "array",
      description: "The changes this turn calls for. Usually empty.",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["create", "update", "delete"] },
          ref: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "A current fact's ref for update and delete, null for create",
          },
          key: { type: "string", description: "snake_case, e.g. never_trade" },
          value: { type: "string", description: "The fact in a few plain words" },
          category: { type: "string", enum: [...TasteFactCategory.options] },
          always_on: { type: "boolean" },
          about: { type: "string", enum: ["user", "other_person"] },
          evidence: { type: "string", enum: ["user_said", "assistant_only"] },
          note: {
            type: "string",
            description: "1 short second-person line, e.g. you'd never trade the Millennium Falcon",
          },
        },
        required: [
          "op",
          "ref",
          "key",
          "value",
          "category",
          "always_on",
          "about",
          "evidence",
          "note",
        ],
      },
    },
  },
  required: ["operations"],
});
