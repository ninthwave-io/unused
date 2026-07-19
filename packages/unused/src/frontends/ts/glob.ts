/**
 * A tiny glob-to-`RegExp` compiler shared by workspace-member detection (T4.2)
 * and config globs (`entry`/`project`/`ignore`/preset entry patterns, T4.3/T4.4,
 * PRD §6). Deliberately minimal — no new runtime dependency, no filesystem walk
 * of its own (callers match this against an already-discovered path list).
 *
 * Supported syntax:
 *  - `*`  — matches within one path segment (never crosses `/`).
 *  - `**` — matches any number of characters, including `/` (any depth). A `/`
 *    immediately following a `**` is consumed too, so `packages/**` also
 *    matches the literal `packages` directory itself.
 *  - `{a,b,c}` — brace alternation (PRD §6's worked example uses a project
 *    glob combining a double-star with a brace extension list). Not nested;
 *    alternatives may themselves contain `*`/`**`.
 *  - Everything else is matched literally (regex metacharacters escaped).
 *
 * A leading `./` and any trailing `/`s are stripped before compilation, so a
 * pattern is always matched against a POSIX-relative path with no leading
 * `./`. The result is fully anchored (`^...$`) — a glob matches a whole path,
 * never a substring.
 *
 * This was originally private to `workspaces.ts` (T4.2); T4.3 needed brace
 * alternation for `project`/`ignore`/`entry` globs (the PRD §6 worked example
 * uses `{ts,tsx}`), so it moved here and `workspaces.ts` now imports it —
 * the one behavioural difference (brace support) is a strict superset: any
 * pre-existing workspace glob containing no `{` compiles identically.
 */

/** Compile `glob` into an anchored `RegExp` over a POSIX-relative path. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  return new RegExp(`^${compile(normalized)}$`);
}

/** Placeholder swapped in for `**` mid-compile so a later literal `*`/`.` pass never re-touches it. */
const DOUBLE_STAR_PLACEHOLDER = "\0GLOB_DOUBLE_STAR\0";

function compile(pattern: string): string {
  let re = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += DOUBLE_STAR_PLACEHOLDER;
        i += 2;
        if (pattern[i] === "/") i += 1; // `**/` also matches the directory itself
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "{") {
      const close = findMatchingBrace(pattern, i);
      if (close === -1) {
        re += "\\{"; // unmatched `{` — treat as a literal
        i += 1;
        continue;
      }
      const alternatives = splitTopLevel(pattern.slice(i + 1, close));
      re += `(?:${alternatives.map(compile).join("|")})`;
      i = close + 1;
      continue;
    }
    if ("\\^$.|?+()[]{}".includes(ch)) {
      re += `\\${ch}`;
      i += 1;
      continue;
    }
    re += ch;
    i += 1;
  }
  return re.split(DOUBLE_STAR_PLACEHOLDER).join(".*");
}

/** Index of the `}` matching the `{` at `openIndex` (brace-depth aware), or `-1`. */
function findMatchingBrace(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < pattern.length; i += 1) {
    if (pattern[i] === "{") depth += 1;
    else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `text` on top-level commas (brace-depth aware, so nesting isn't split early). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}
