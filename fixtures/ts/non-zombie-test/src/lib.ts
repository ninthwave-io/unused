export function livefn(): string {
  return "alive";
}

// Exported but never imported anywhere in this fixture: a clean dead export,
// unrelated to the non-zombie-test mechanism this case targets — a baseline
// proof the analyzer still finds a real dead export in a fixture that is
// otherwise all-alive.
export function deadFn(): number {
  return 0;
}
