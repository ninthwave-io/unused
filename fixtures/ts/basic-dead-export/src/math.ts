export function add(a: number, b: number): number {
  return a + b;
}

// Exported but never imported anywhere in this fixture: the baseline dead-export case.
export function subtract(a: number, b: number): number {
  return a - b;
}
