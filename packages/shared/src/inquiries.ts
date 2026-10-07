import { z } from "zod";
import { DealItem } from "./deals.js";

// The Liaison's question to the person asked (docs/contracts/m3-matcher.md, "Inquiries"):
// would an Item that's close to what they asked for, but not what they named, work?

export const Inquiry = z.object({
  id: z.uuid(),
  /** The person's own Ask the Item might fill. */
  ask_id: z.uuid(),
  ask_title: z.string(),
  /** Someone in their Circles has it. Who isn't said until there's a Deal Sheet. */
  item: DealItem,
  expires_at: z.iso.datetime({ offset: true }),
});
export type Inquiry = z.infer<typeof Inquiry>;

export const InquiriesResponse = z.object({ inquiries: z.array(Inquiry) });
export type InquiriesResponse = z.infer<typeof InquiriesResponse>;

export const InquiryAnswer = z.strictObject({ answer: z.enum(["yes", "no"]) });
export type InquiryAnswer = z.infer<typeof InquiryAnswer>;
