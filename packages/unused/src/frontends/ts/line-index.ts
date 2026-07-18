/**
 * Offset → line mapping for provenance spans.
 *
 * oxc-parser emits UTF-16 code-unit offsets (i.e. JS string indices — verified
 * empirically against the pinned 0.140.0 build), so we scan the JS source
 * string directly. Line starts are precomputed once per file; lookups are
 * binary searches.
 */
import type { Span } from "./module-record.js";

const NEWLINE = 10; // "\n"

export class LineIndex {
  /** `lineStarts[i]` = offset of the first char of line `i` (0-based line array). */
  private readonly lineStarts: number[];

  constructor(source: string) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === NEWLINE) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  /** 1-based line number containing the 0-based `offset`. */
  lineAt(offset: number): number {
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      // starts[mid] is always defined for 0 <= mid < length.
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Build a provenance {@link Span} from a half-open `[start, end)` offset range. */
  span(start: number, end: number): Span {
    // `end` is exclusive; the last content char is at `end - 1`.
    const endLineOffset = end > start ? end - 1 : start;
    return {
      start,
      end,
      startLine: this.lineAt(start),
      endLine: this.lineAt(endLineOffset),
    };
  }
}
