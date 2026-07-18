export function ping(): string {
  return "pong";
}

// Exported but never imported anywhere in this fixture: a clean dead export,
// unrelated to the test-root mechanism this case exercises.
export function deadHelper(): number {
  return 0;
}
