// An ordinary component living alongside route files — NOT a Next.js
// convention filename, so the next preset's entryPatterns must not match it.
// Nothing else in the project imports it: must be flagged dead/high (the
// T4.4 fixture's "orphan component dead/high" requirement — proves the
// preset doesn't blanket-alive everything under src/app's sibling tree).
export function OrphanButton(): string {
  return "orphan-button";
}
