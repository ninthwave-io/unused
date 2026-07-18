export function used(): number {
  return 1;
}

// A genuine dead export in a NON-augmented file — the control proving the
// analyzer still flags real dead code (only the merge participant is spared).
export function deadControl(): number {
  return 2;
}
