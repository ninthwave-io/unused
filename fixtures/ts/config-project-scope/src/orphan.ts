// Unreferenced anywhere, and inside the "project": ["src/**"] scope — a
// clean, in-scope dead file (the zero-inbound control beside helper.ts, whose
// only inbound edge comes from unreachable code).
export function orphanFn(): string {
  return "orphan";
}
