// The sibling project this package's tsconfig `references` composes with.
// Consumed here via a normal relative import (a plausible same-checkout
// monorepo layout) — proves the whole-package cap does not suppress a
// genuinely alive cross-project import.
export function shared(): string {
  return "shared";
}
