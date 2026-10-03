/**
 * Helpers for text written by other users (item descriptions, counter notes, names).
 * Every such string is sanitized and fenced before any agent sees it.
 */

export const DEFAULT_UNTRUSTED_MAX_LENGTH = 4000;

// C0 and C1 control characters except tab (\u0009), newline (\u000A) and carriage return (\u000D).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Zero-width and invisible formatting characters, bidi overrides, BOM, tag characters.
// biome-ignore lint/suspicious/noMisleadingCharacterClass: each listed code point is stripped on its own.
const INVISIBLE_CHARS = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|\uDB40[\uDC00-\uDC7F]/g;

export interface SanitizeOptions {
  maxLength?: number;
}

/** Normalizes, strips control and invisible characters, and caps the length. */
export function sanitizeUntrusted(text: string, options: SanitizeOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_UNTRUSTED_MAX_LENGTH;
  const cleaned = text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "");
  if (cleaned.length <= maxLength) return cleaned;
  // Avoid cutting a surrogate pair in half.
  const chars = Array.from(cleaned).slice(0, maxLength);
  return `${chars.join("")}…`;
}

const LABEL_PATTERN = /^[a-z0-9_.:-]{1,64}$/i;

/** Neutralizes anything that could open or close a fence inside the content. */
function escapeFenceTags(text: string): string {
  return text.replace(/<(?=\s*\/?\s*untrusted_content)/gi, "&lt;");
}

/**
 * Sanitizes text and wraps it in an untrusted_content fence. The label names the source,
 * for example `item_description` or `counter_note`.
 */
export function fenceUntrusted(label: string, text: string, options: SanitizeOptions = {}): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`Invalid untrusted_content label: ${JSON.stringify(label)}`);
  }
  const body = escapeFenceTags(sanitizeUntrusted(text, options));
  return `<untrusted_content source="${label}">\n${body}\n</untrusted_content>`;
}
