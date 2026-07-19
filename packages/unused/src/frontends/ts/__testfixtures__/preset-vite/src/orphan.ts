// A genuine orphan — nothing in the index.html → main.ts → app.ts chain
// reaches it. Must be flagged dead/high (zero false positives on this fixture).
export function orphan(): string {
  return "orphan";
}
