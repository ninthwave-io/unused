/**
 * A hand-rolled JSONC → JSON normalizer for `unused.config.jsonc` (T4.3,
 * phasing.md M4, ADR 0010). ADR 0010 commits to JSONC specifically *because*
 * it never executes user code; pulling in a comment-stripping dependency for
 * this one small, well-understood transform would be a needless new runtime
 * dependency, so it is hand-rolled here (spec: "prefer zero new runtime
 * deps: hand-roll a comment/trailing-comma stripper with tests").
 *
 * Handles exactly the two JSONC extensions over strict JSON:
 *  - `//` line comments and `/*` block comments, outside string literals.
 *  - Trailing commas before a closing `}`/`]`.
 *
 * Deliberately NOT a general JS/JSON5 parser: no single-quoted strings, no
 * unquoted keys, no comments *inside* a string (those are just string
 * content, correctly left alone). The result is fed straight to `JSON.parse`,
 * which enforces everything else (and is the actual source of truth for
 * "valid JSON" — this module only removes the two JSONC-specific extensions).
 *
 * Two passes, each string-literal-aware (tracks `inString` with escape
 * handling so a `//`, `/*`, or `,` *inside* a quoted string is never touched):
 *  1. {@link stripComments} — replaces comment characters with whitespace
 *     (newlines preserved as newlines, everything else as a space), so byte
 *     positions and line numbers in the result line up with the original
 *     file — a `JSON.parse` syntax error's line number still points at the
 *     right place in the source the user wrote.
 *  2. {@link stripTrailingCommas} — replaces a comma with a space when the
 *     next non-whitespace character is `}` or `]`.
 */

/** Strip line comments, block comments, and trailing commas, leaving valid JSON (or still-invalid JSON, which `JSON.parse` will reject with its own message). */
export function stripJsonComments(source: string): string {
  return stripTrailingCommas(stripComments(source));
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let inString = false;
  while (i < n) {
    const ch = source[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1; // consume the comment body; leave the \n itself
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      i += 2; // consume the closing `*/` (or run off the end of an unterminated comment)
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function stripTrailingCommas(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let inString = false;
  while (i < n) {
    const ch = source[i] as string;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(source[j] as string)) j += 1;
      if (source[j] === "}" || source[j] === "]") {
        out += " "; // drop the trailing comma, preserving length/line numbers
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}
