/// <reference types="some-types" />

// `some-types` is referenced only by the triple-slash directive above (a comment
// that never becomes an import edge) — it must be kept alive. `dead-lib` is
// referenced nowhere and is claimed.
export const value: number = 1;
