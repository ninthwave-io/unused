// Outside "project": ["src/**/*.ts"] — undiscovered: never parsed, never
// claimed, even though it is also a genuine orphan.
export function outsideOrphan(): string {
  return "outside-orphan";
}
