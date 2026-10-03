/** Text the Refiner shows the owner: plain, short, and never an authenticity claim. */

// Em dash (U+2014) and en dash (U+2013), built from code points so no dash sits in the source.
const DASHES = new RegExp(`\\s*[${String.fromCharCode(0x2014, 0x2013)}]\\s*`, "g");
const AUTHENTICITY =
  /\b(authentic(ity|ated)?|genuine|legit(imate)?|counterfeit|fake|replica|real deal)\b/i;

/** Em and en dashes become commas, whitespace collapses. */
export function plain(text: string) {
  return text
    .replace(DASHES, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

export const claimsAuthenticity = (text: string) => AUTHENTICITY.test(text);

/**
 * 2 to 3 plain sentences: drops any sentence about authenticity, keeps the first 3, caps
 * the length. Null when nothing usable is left.
 */
export function cleanDescription(text: string | null | undefined, maxLength = 600) {
  if (!text) return null;
  const sentences = (plain(text).match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !claimsAuthenticity(s))
    .slice(0, 3);
  if (sentences.length === 0) return null;
  let out = sentences.join(" ");
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1).trimEnd()}…`;
  return out;
}
