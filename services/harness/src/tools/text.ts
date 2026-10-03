import { fenceUntrusted } from "@throwin/shared";
import type { AskRecord, NetworkItem, OwnItem } from "../data.js";
import { askTitle, clean, usd, usdRange } from "../format.js";

// How tool results describe things to the model. IDs, prices and grades come from the
// server and stay outside fences; anything another person wrote is fenced.

const valueText = (low: number | null, high: number | null) =>
  low !== null && high !== null ? usdRange(low, high) : "not priced yet";

export function ownItemText(i: OwnItem, detail = false): string {
  const lines = [
    `- id: ${i.id}`,
    `  title: ${clean(i.title, 120) || "(untitled)"}`,
    `  status: ${i.status}${i.reserved ? " (held by a Deal)" : ""}, willingness: ${i.willingness}, readiness: ${i.readiness}`,
    `  condition: ${i.conditionGrade ?? "not graded"}, value: ${valueText(i.valueLowCents, i.valueHighCents)}${i.appraising ? " (still being priced)" : ""}`,
  ];
  if (detail) {
    const facts = [
      i.brand && `brand ${clean(i.brand, 60)}`,
      i.model && `model ${clean(i.model, 60)}`,
    ]
      .filter(Boolean)
      .join(", ");
    if (facts) lines.push(`  ${facts}`);
    if (i.defects.length) lines.push(`  defects: ${i.defects.map((d) => clean(d, 80)).join("; ")}`);
    if (i.missingAngles.length) lines.push(`  photos still missing: ${i.missingAngles.join("; ")}`);
    if (i.description) {
      lines.push(
        `  description:\n${fenceUntrusted("item_description", i.description, { maxLength: 600 })}`,
      );
    }
  }
  return lines.join("\n");
}

export function networkItemText(i: NetworkItem, detail = false): string {
  const lines = [
    `- id: ${i.id}`,
    `  owner:\n${fenceUntrusted("owner_name", i.ownerFirstName, { maxLength: 40 })}`,
    `  title:\n${fenceUntrusted("item_title", i.title, { maxLength: 120 })}`,
    `  condition: ${i.conditionGrade ?? "not graded"}, value: ${valueText(i.valueLowCents, i.valueHighCents)}`,
  ];
  if (detail && i.description) {
    lines.push(
      `  description:\n${fenceUntrusted("item_description", i.description, { maxLength: 600 })}`,
    );
  }
  return lines.join("\n");
}

export function askText(
  a: AskRecord,
  statusLine: string,
  offer: { low_cents: number; high_cents: number } | null,
) {
  const t = a.target;
  const lines = [
    `- ask_id: ${a.id}`,
    `  title: ${clean(askTitle(a) ?? a.rawText, 120)}`,
    `  status: ${a.status} (${statusLine})`,
    `  their words: ${clean(a.rawText, 200)}`,
  ];
  if (t?.anchor) {
    lines.push(
      `  price anchor: ${t.anchor.retail_cents !== null ? `retail ${usd(t.anchor.retail_cents)}, ` : ""}used ${usdRange(t.anchor.used_low_cents, t.anchor.used_high_cents)}`,
    );
  }
  if (t?.constraints.length)
    lines.push(`  constraints: ${t.constraints.map((c) => clean(c, 80)).join("; ")}`);
  lines.push(
    `  offer: ${a.offerItemIds.length} Item${a.offerItemIds.length === 1 ? "" : "s"}${a.offerItemIds.length ? ` (${a.offerItemIds.join(", ")})` : ""}${offer ? `, worth ${usdRange(offer.low_cents, offer.high_cents)}` : ""}, cash up to ${usd(a.cashCeilingCents)}`,
  );
  lines.push(`  autonomy: ${a.autonomy}`);
  return lines.join("\n");
}
