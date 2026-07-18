export function used(): number {
  return 1;
}

// A clean dead export. In a stand-alone project it is a high-confidence claim;
// under tsconfig `references` it is capped to medium (a sibling project may
// consume it across the project boundary — a use this analysis cannot see).
export function deadButMaybeConsumed(): number {
  return 2;
}
