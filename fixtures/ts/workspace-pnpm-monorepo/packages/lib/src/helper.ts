export function helper(): string {
  return "helper";
}

// Exported but re-exported/imported by nothing — no barrel, no sibling
// workspace member, nothing. A per-workspace dead export inside @fix/lib.
export function deadHelper(): string {
  return "dead";
}
