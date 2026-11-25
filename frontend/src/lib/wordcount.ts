/**
 * Word-count rule — MUST match backend/app/observations/wordcount.py
 * NFKC → control→space → split on Unicode whitespace → count non-empty tokens.
 */
export const MAX_WORDS = 300;

export function normalizeForCount(text: string): string {
  const s = text.normalize("NFKC");
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\t" || ch === "\n" || ch === "\r") out += " ";
    else if (code < 32 || (code >= 0x7f && code <= 0x9f)) out += " ";
    else out += ch;
  }
  return out;
}

export function countWords(text: string): number {
  const s = normalizeForCount(text).trim();
  if (!s) return 0;
  return s.split(/\s+/u).filter(Boolean).length;
}

export function wordsOverLimit(text: string, limit = MAX_WORDS): number {
  return Math.max(0, countWords(text) - limit);
}
