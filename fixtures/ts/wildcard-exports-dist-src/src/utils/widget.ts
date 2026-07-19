// Public API reachable ONLY through the wildcard subpath export
// `"./utils/*": "./dist/utils/*.js"` — nothing in `src/` imports it. On an
// unbuilt clone the wildcard target's `dist/utils/` directory does not exist,
// so without the wildcard dist/**→src/** remap this file (and its test) are
// wrongly claimed test-only/zombie. With the remap it is a production
// entrypoint: alive, never claimed.
export function widget(): number {
  return 42;
}
