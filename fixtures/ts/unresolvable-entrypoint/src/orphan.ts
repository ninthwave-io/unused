// Genuinely unreferenced by anything in this fixture. Because package.json's
// "bin" target ("dist/cli.js") has no `src/cli.*` counterpart, the
// `unresolvable-entrypoint-target` hazard fires and caps the WHOLE package at
// medium — so even this clean orphan cannot be claimed at high.
export function neverCalled(): void {
  // noop
}
