// A genuine orphan, IN project scope — must still be flagged (proves the fix
// doesn't blanket-alive the codebase, only relaxes out-of-project claimability).
export function orphan(): string {
  return "orphan";
}
