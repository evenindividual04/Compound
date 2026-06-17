/**
 * Strip likely-PII before sending merchant text to a cloud model (spec §6).
 * Removes digit runs ≥4, masked-account tokens (X{2,}\d+), and collapses separators.
 * Returns null (fail closed) if no non-trivial alphabetic content survives.
 */
export function redactForLlm(text: string): string | null {
  let s = text
    .replace(/\bX{2,}\d+\b/gi, " ")        // masked account tokens
    .replace(/\d{4,}\b/g, " ")              // long digit runs
    .replace(/[\/_]+/g, " ")                // separators
    .replace(/\s+/g, " ")
    .trim();
  // strip leftover short numeric-only tokens
  s = s.split(" ").filter((t) => !/^\d+$/.test(t)).join(" ").trim();
  if (!/[a-z]{2,}/i.test(s)) return null;   // nothing meaningful left → abstain
  return s;
}
