// A computed require with a fully opaque (non-string-literal) argument: no
// derivable static prefix, so it raises a WHOLE-PACKAGE computed-require hazard.
// Post-fix (reference-codebase §4.3) that cap must scope to THIS package (pkg-a) only —
// it must NOT reach pkg-b's unrelated claims across the shared workspace graph.
export function loadPlugin(moduleName: string): unknown {
  return require(moduleName);
}
