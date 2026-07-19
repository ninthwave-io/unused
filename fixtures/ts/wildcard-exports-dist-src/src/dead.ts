// Genuinely dead: not the `.` entry, not under the `./utils/*` wildcard prefix,
// imported by nothing. Recall baseline — both declared entry targets resolve
// (via remap), so NO unresolvable-entrypoint-target hazard caps the package,
// and this stays claimable at high confidence.
export function deadUtil(): number {
  return 0;
}
