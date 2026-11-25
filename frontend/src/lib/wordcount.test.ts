import { describe, expect, it } from "vitest";
import { MAX_WORDS, countWords, wordsOverLimit } from "./wordcount";

describe("wordcount (matches backend)", () => {
  it("empty / whitespace → 0", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  \n\t ")).toBe(0);
  });

  it("300 ok, 301 over", () => {
    const w300 = Array.from({ length: MAX_WORDS }, (_, i) => `w${i}`).join(" ");
    const w301 = `${w300} extra`;
    expect(countWords(w300)).toBe(300);
    expect(wordsOverLimit(w300)).toBe(0);
    expect(countWords(w301)).toBe(301);
    expect(wordsOverLimit(w301)).toBe(1);
  });

  it("collapses spaces and handles accents", () => {
    expect(countWords("  one   two\nthree  ")).toBe(3);
    expect(countWords("café naïve")).toBe(2);
  });
});
