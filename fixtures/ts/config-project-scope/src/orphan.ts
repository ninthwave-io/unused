// Unreferenced anywhere, and inside the "project": ["src/**"] scope — a
// clean, in-scope dead file (the control case alongside the narrowing trap).
export function orphanFn(): string {
  return "orphan";
}
